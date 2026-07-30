/*
 * Admin service catalog orchestration.
 *
 * Governed by PROJECT_LOCK Amendment 004. The ordering rules in
 * this file are the substance of the amendment, not incidental:
 *
 * - creation is database-first, so a Stripe failure leaves a real
 *   row to resume against rather than an orphaned Stripe object;
 * - a pricing change commits the database before retiring the
 *   superseded Payment Link, so the service never references a
 *   dead link (section 8.4.3);
 * - deactivation and deletion retire the Payment Link before the
 *   database changes, so a withdrawn service is never still
 *   purchasable.
 *
 * The two orderings look contradictory and are not. The single
 * rule underneath both: the live Stripe surface must never be
 * broader than what the database advertises.
 */

import { randomUUID } from "node:crypto";
import type { StripeFailure } from "./admin-service.stripe.js";
import {
  archiveProduct,
  computeGenerationFingerprint,
  createPaymentLink,
  createPrice,
  createProduct,
  deactivatePaymentLink,
  deactivatePrice,
  isResourceMissing,
  paymentLinkMatchesPrice,
  retrievePaymentLink,
  updateProductDescriptive,
} from "./admin-service.stripe.js";
import {
  buildCreateIdempotencyKey,
  buildLease,
  claimCreateIdempotency,
  compareAndSetIdempotency,
  hashCanonicalBody,
  isLeaseExpired,
  acquireServiceLock,
  releaseServiceLock,
  type CreateIdempotencyFailureStage,
  type CreateIdempotencyRecord,
  type CreateIdempotencySession,
} from "./admin-service.locks.js";
import {
  clearPricing,
  countServiceReferences,
  deleteService as deleteServiceRow,
  getServiceById,
  insertService,
  persistPriceDisplay,
  persistPricingAndStripeIdentifiers,
  persistProductId,
  setActiveState,
  updateDescriptiveFields,
  type ServiceRow,
} from "./admin-service.repository.js";
import {
  formatPriceDisplay,
  interpretPatchPricing,
  toStructuredPricing,
  type CreateServiceBody,
  type PatchServiceBody,
  type StructuredPricing,
} from "./admin-service.schema.js";

/*
 * Bounded escalation used only if Stripe replays an inactive
 * resource for a generation key. Kept small: it is a safety net,
 * not an expected path.
 */
const MAX_GENERATION_ATTEMPTS = 3;

/*
 * Only the codes in API_CONTRACT.md section 0. Amendment 004
 * section 14.3.9 requires a fixed machine-readable set; specific
 * 409 causes are carried in details.reason rather than in new
 * codes.
 */
export type AdminServiceErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "STRIPE_ERROR"
  | "INTERNAL";

export type AdminServiceFailure = {
  ok: false;
  code: AdminServiceErrorCode;
  message: string;
  details?: unknown;
};

export type AdminServiceResult =
  | {
      ok: true;
      service: ServiceRow;
    }
  | AdminServiceFailure;

export type AdminServiceDeleteResult =
  | {
      ok: true;
      deleted: true;
      id: string;
    }
  | AdminServiceFailure;

const GENERIC_STRIPE_MESSAGE =
  "The service could not be synchronised with the payment provider.";

const GENERIC_INTERNAL_MESSAGE =
  "The service could not be updated.";

/*
 * Stripe detail is logged and never returned (section 14.3.11).
 * The response carries no Stripe message, request identifier or
 * decline code.
 */
const logStripeFailure = (
  operation: string,
  context: Record<string, unknown>,
  failure: StripeFailure,
): void => {
  console.error(
    `Admin service Stripe ${operation} failed`,
    {
      ...context,
      stripeErrorType: failure.type,
      stripeErrorCode: failure.code,
      stripeRequestId:
        failure.requestId,
      stripeMessage: failure.message,
    },
  );
};

const nowIso = (): string =>
  new Date().toISOString();

const reload = async (
  serviceId: string,
): Promise<
  | {
      ok: true;
      service: ServiceRow;
    }
  | AdminServiceFailure
> => {
  const result =
    await getServiceById(serviceId);

  if (!result.ok) {
    return {
      ok: false,
      code: "INTERNAL",
      message:
        GENERIC_INTERNAL_MESSAGE,
    };
  }

  if (!result.value) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Service not found.",
    };
  }

  return {
    ok: true,
    service: result.value,
  };
};

const readPricing = (
  service: ServiceRow,
): StructuredPricing | null => {
  return toStructuredPricing({
    billing_type:
      service.billing_type,
    recurring_interval:
      service.recurring_interval,
    price_cents: service.price_cents,
    currency: service.currency,
  });
};

const samePricing = (
  left: StructuredPricing,
  right: StructuredPricing,
): boolean => {
  return (
    left.billingType ===
      right.billingType &&
    left.recurringInterval ===
      right.recurringInterval &&
    left.priceCents ===
      right.priceCents &&
    left.currency === right.currency
  );
};

/*
 * Product, Price and Payment Link provisioning shared by create,
 * patch and activate.
 *
 * Always reconciles from the row rather than replaying blindly,
 * so a resumed operation performs only the steps still missing.
 */
type ProvisionOutcome =
  | {
      ok: true;
      service: ServiceRow;
    }
  | {
      ok: false;
      stage: CreateIdempotencyFailureStage;
      failure: AdminServiceFailure;
    };

const provisionPricing = async ({
  service,
  pricing,
}: {
  service: ServiceRow;
  pricing: StructuredPricing;
}): Promise<ProvisionOutcome> => {
  const serviceId = service.id;

  let productId =
    service.stripe_product_id;

  if (!productId) {
    const created =
      await createProduct({
        serviceId,
        name: service.name,
        description:
          service.description,
      });

    if (!created.ok) {
      logStripeFailure(
        "product creation",
        { serviceId },
        created.failure,
      );

      return {
        ok: false,
        stage: "product",
        failure: {
          ok: false,
          code: "STRIPE_ERROR",
          message:
            GENERIC_STRIPE_MESSAGE,
        },
      };
    }

    productId = created.value.id;

    const persisted =
      await persistProductId({
        serviceId,
        stripeProductId: productId,
      });

    if (!persisted.ok) {
      return {
        ok: false,
        stage: "persist_product_id",
        failure: {
          ok: false,
          code: "INTERNAL",
          message:
            GENERIC_INTERNAL_MESSAGE,
        },
      };
    }
  }

  /*
   * The generation is derived from the resources being replaced,
   * not from the pricing values alone, so a revert to a previous
   * price is a new generation rather than a replay of the old
   * one. See computeGenerationFingerprint.
   */
  const generation =
    computeGenerationFingerprint({
      pricing,
      previousPriceId:
        service.stripe_price_id,
      previousPaymentLinkId:
        service.stripe_payment_link_id,
    });

  let priceId: string | null = null;

  for (
    let attempt = 0;
    attempt < MAX_GENERATION_ATTEMPTS;
    attempt += 1
  ) {
    const created = await createPrice({
      serviceId,
      stripeProductId: productId,
      pricing,
      generation,
      attempt,
    });

    if (!created.ok) {
      logStripeFailure(
        "price creation",
        {
          serviceId,
          generation,
          attempt,
        },
        created.failure,
      );

      return {
        ok: false,
        stage: "price",
        failure: {
          ok: false,
          code: "STRIPE_ERROR",
          message:
            GENERIC_STRIPE_MESSAGE,
        },
      };
    }

    /*
     * An inactive Price must never become the current one. This
     * should be unreachable now that the generation covers the
     * superseded resources, so it is logged rather than silently
     * escalated.
     */
    if (created.value.active !== false) {
      priceId = created.value.id;
      break;
    }

    console.error(
      "Admin service received an inactive Stripe Price for a generation key",
      {
        serviceId,
        generation,
        attempt,
        stripePriceId: created.value.id,
      },
    );
  }

  if (!priceId) {
    return {
      ok: false,
      stage: "price",
      failure: {
        ok: false,
        code: "STRIPE_ERROR",
        message: GENERIC_STRIPE_MESSAGE,
      },
    };
  }

  let linkId: string | null = null;

  let linkUrl: string | null = null;

  for (
    let attempt = 0;
    attempt < MAX_GENERATION_ATTEMPTS;
    attempt += 1
  ) {
    const created =
      await createPaymentLink({
        serviceId,
        stripePriceId: priceId,
        generation,
        attempt,
      });

    if (!created.ok) {
      logStripeFailure(
        "payment link creation",
        {
          serviceId,
          stripePriceId: priceId,
          generation,
          attempt,
        },
        created.failure,
      );

      return {
        ok: false,
        stage: "link",
        failure: {
          ok: false,
          code: "STRIPE_ERROR",
          message:
            GENERIC_STRIPE_MESSAGE,
        },
      };
    }

    if (created.value.active !== false) {
      linkId = created.value.id;
      /*
       * The URL is taken only from the Stripe response. It is
       * never constructed or templated (section 8.3.3).
       */
      linkUrl = created.value.url;
      break;
    }

    console.error(
      "Admin service received an inactive Stripe Payment Link for a generation key",
      {
        serviceId,
        generation,
        attempt,
        stripePaymentLinkId:
          created.value.id,
      },
    );
  }

  if (!linkId || !linkUrl) {
    return {
      ok: false,
      stage: "link",
      failure: {
        ok: false,
        code: "STRIPE_ERROR",
        message: GENERIC_STRIPE_MESSAGE,
      },
    };
  }

  const persisted =
    await persistPricingAndStripeIdentifiers(
      {
        serviceId,
        pricing,
        stripePriceId: priceId,
        stripePaymentLinkId: linkId,
        stripePaymentLinkUrl: linkUrl,
      },
    );

  if (!persisted.ok) {
    return {
      ok: false,
      stage: "persist",
      failure: {
        ok: false,
        code: "INTERNAL",
        message:
          GENERIC_INTERNAL_MESSAGE,
      },
    };
  }

  const reloaded =
    await reload(serviceId);

  if (!reloaded.ok) {
    return {
      ok: false,
      stage: "persist",
      failure: reloaded,
    };
  }

  return {
    ok: true,
    service: reloaded.service,
  };
};

/*
 * Superseded resources are retired only after the database
 * references their replacement (section 8.4.3), and are
 * deactivated rather than deleted (sections 8.2.4 and 8.3.2).
 *
 * A retirement failure never rolls back a valid replacement. The
 * database is correct; the residue is a superseded object left
 * active in Stripe, which is logged for reconciliation.
 */
const retireSupersededResources =
  async ({
    serviceId,
    previousPaymentLinkId,
    previousPriceId,
  }: {
    serviceId: string;
    previousPaymentLinkId:
      | string
      | null;
    previousPriceId: string | null;
  }): Promise<void> => {
    if (previousPaymentLinkId) {
      const result =
        await deactivatePaymentLink(
          previousPaymentLinkId,
        );

      if (!result.ok) {
        logStripeFailure(
          "superseded payment link deactivation",
          {
            serviceId,
            stripePaymentLinkId:
              previousPaymentLinkId,
          },
          result.failure,
        );
      }
    }

    if (previousPriceId) {
      const result =
        await deactivatePrice(
          previousPriceId,
        );

      if (!result.ok) {
        logStripeFailure(
          "superseded price deactivation",
          {
            serviceId,
            stripePriceId:
              previousPriceId,
          },
          result.failure,
        );
      }
    }
  };

const buildInitialRecord = ({
  requestHash,
  serviceId,
}: {
  requestHash: string;
  serviceId: string;
}): CreateIdempotencyRecord => {
  const timestamp = nowIso();

  return {
    status: "in_progress",
    request_hash: requestHash,
    service_id: serviceId,
    response: null,
    failure_stage: null,
    ...buildLease(),
    attempt: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
};

const saveRecord = async ({
  session,
  patch,
}: {
  session: CreateIdempotencySession;
  patch: Partial<CreateIdempotencyRecord>;
}): Promise<boolean> => {
  const next: CreateIdempotencyRecord =
    {
      ...session.record,
      ...patch,
      ...buildLease(),
      updated_at: nowIso(),
    };

  return compareAndSetIdempotency({
    session,
    next,
  });
};

export type CreateServiceInput = {
  adminProfileId: string;
  idempotencyKey: string;
  body: CreateServiceBody;
};

/*
 * POST /api/admin/services
 *
 * Database-first: the row is inserted before any Stripe call, so
 * every provisioning failure leaves something durable to resume
 * against. Stripe provisioning is not deferred when complete
 * pricing was supplied.
 *
 * The service identifier is generated here and written into the
 * idempotency record before the insert. Recording it only after
 * the insert would leave a window in which a crash orphans a row
 * that the retry cannot find, and the retry would insert a
 * second one - the exact duplicate this record exists to prevent.
 */
export const createService = async ({
  adminProfileId,
  idempotencyKey,
  body,
}: CreateServiceInput): Promise<AdminServiceResult> => {
  const key =
    buildCreateIdempotencyKey({
      adminProfileId,
      idempotencyKey,
    });

  const requestHash =
    hashCanonicalBody(body);

  const claim =
    await claimCreateIdempotency({
      key,
      record: buildInitialRecord({
        requestHash,
        serviceId: randomUUID(),
      }),
    });

  if (
    !claim.ok &&
    claim.reason === "unavailable"
  ) {
    return {
      ok: false,
      code: "INTERNAL",
      message:
        GENERIC_INTERNAL_MESSAGE,
    };
  }

  let session: CreateIdempotencySession;

  if (claim.ok) {
    session = claim.session;
  } else {
    const existing = claim.record;

    /*
     * Payload mismatch is checked before status, so a reused key
     * is always reported as reused rather than being masked by
     * an in-flight or completed state.
     */
    if (
      existing.request_hash !==
      requestHash
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "This Idempotency-Key was already used with a different request.",
        details: {
          reason:
            "idempotency_key_reused",
        },
      };
    }

    if (
      existing.status === "completed"
    ) {
      return {
        ok: true,
        service:
          existing.response as ServiceRow,
      };
    }

    if (
      existing.status ===
        "in_progress" &&
      !isLeaseExpired(existing)
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "An identical request is already being processed.",
        details: {
          reason:
            "request_in_progress",
        },
      };
    }

    /*
     * Either a recoverable failure, or an in-progress record
     * whose lease expired because the previous worker died.
     * Ownership is taken atomically so a live lease is never
     * overwritten.
     */
    const takeoverSession: CreateIdempotencySession =
      {
        key,
        raw: claim.raw,
        record: existing,
      };

    const takenOver = await saveRecord(
      {
        session: takeoverSession,
        patch: {
          status: "in_progress",
          attempt:
            existing.attempt + 1,
        },
      },
    );

    if (!takenOver) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "An identical request is already being processed.",
        details: {
          reason:
            "request_in_progress",
        },
      };
    }

    session = takeoverSession;
  }

  const serviceId =
    session.record.service_id ??
    randomUUID();

  const failWith = async ({
    stage,
    failure,
  }: {
    stage: CreateIdempotencyFailureStage;
    failure: AdminServiceFailure;
  }): Promise<AdminServiceFailure> => {
    await saveRecord({
      session,
      patch: {
        status:
          "recoverable_failure",
        failure_stage: stage,
        service_id: serviceId,
      },
    });

    return {
      ...failure,
      details: {
        service_id: serviceId,
        reason:
          failure.code ===
          "STRIPE_ERROR"
            ? "stripe_provisioning_failed"
            : "provisioning_incomplete",
      },
    };
  };

  const existingRow =
    await getServiceById(serviceId);

  if (!existingRow.ok) {
    return failWith({
      stage: "insert",
      failure: {
        ok: false,
        code: "INTERNAL",
        message:
          GENERIC_INTERNAL_MESSAGE,
      },
    });
  }

  let service = existingRow.value;

  if (!service) {
    const inserted =
      await insertService({
        serviceId,
        name: body.name,
        description:
          body.description ?? null,
        sortOrder:
          body.sort_order ?? null,
      });

    if (!inserted.ok) {
      return failWith({
        stage: "insert",
        failure: {
          ok: false,
          code: "INTERNAL",
          message:
            GENERIC_INTERNAL_MESSAGE,
        },
      });
    }

    service = inserted.value;
  }

  const pricing =
    toStructuredPricing(body);

  if (pricing) {
    const alreadyProvisioned =
      readPricing(service) !== null &&
      service.stripe_payment_link_id !==
        null;

    if (!alreadyProvisioned) {
      const provisioned =
        await provisionPricing({
          service,
          pricing,
        });

      if (!provisioned.ok) {
        return failWith({
          stage: provisioned.stage,
          failure:
            provisioned.failure,
        });
      }

      service = provisioned.service;
    }
  }

  /*
   * The response is read back from the database, never reflected
   * from the submitted values (section 14.3.8).
   */
  const authoritative =
    await reload(serviceId);

  if (!authoritative.ok) {
    return failWith({
      stage: "persist",
      failure: authoritative,
    });
  }

  await saveRecord({
    session,
    patch: {
      status: "completed",
      failure_stage: null,
      service_id: serviceId,
      response: authoritative.service,
    },
  });

  return {
    ok: true,
    service: authoritative.service,
  };
};

type LockedOperation<T> = (
  service: ServiceRow,
) => Promise<T>;

const withServiceLock = async <
  T extends { ok: boolean },
>({
  serviceId,
  operation,
  onMissing,
  onUnavailable,
  onContended,
}: {
  serviceId: string;
  operation: LockedOperation<T>;
  onMissing: () => T;
  onUnavailable: () => T;
  onContended: () => T;
}): Promise<T> => {
  const lock =
    await acquireServiceLock(
      serviceId,
    );

  if (!lock.ok) {
    return lock.reason === "contended"
      ? onContended()
      : onUnavailable();
  }

  try {
    const loaded =
      await getServiceById(serviceId);

    if (!loaded.ok) {
      return onUnavailable();
    }

    if (!loaded.value) {
      return onMissing();
    }

    return await operation(
      loaded.value,
    );
  } finally {
    await releaseServiceLock(
      lock.lock,
    );
  }
};

const notFound = (): AdminServiceFailure => ({
  ok: false,
  code: "NOT_FOUND",
  message: "Service not found.",
});

const internal = (): AdminServiceFailure => ({
  ok: false,
  code: "INTERNAL",
  message: GENERIC_INTERNAL_MESSAGE,
});

const contended = (): AdminServiceFailure => ({
  ok: false,
  code: "INVALID_TRANSITION",
  message:
    "This service is already being modified.",
  details: {
    reason: "mutation_in_progress",
  },
});

export type UpdateServiceInput = {
  serviceId: string;
  rawBody: unknown;
  body: PatchServiceBody;
};

/*
 * PATCH /api/admin/services/:id
 */
export const updateService = async ({
  serviceId,
  rawBody,
  body,
}: UpdateServiceInput): Promise<AdminServiceResult> => {
  return withServiceLock<AdminServiceResult>(
    {
      serviceId,
      onMissing: notFound,
      onUnavailable: internal,
      onContended: contended,
      operation: async (service) => {
        const intent =
          interpretPatchPricing(
            rawBody,
            body,
          );

        if (
          intent.kind === "invalid"
        ) {
          return {
            ok: false,
            code: "VALIDATION_ERROR",
            message: intent.message,
          };
        }

        if (
          intent.kind ===
            "clear_pricing" &&
          service.is_active
        ) {
          return {
            ok: false,
            code: "INVALID_TRANSITION",
            message:
              "Deactivate the service before removing its pricing.",
            details: {
              reason:
                "service_active",
            },
          };
        }

        const descriptiveUpdate =
          await updateDescriptiveFields(
            {
              serviceId,
              ...(body.name ===
              undefined
                ? {}
                : {
                    name: body.name,
                  }),
              ...(body.description ===
              undefined
                ? {}
                : {
                    description:
                      body.description ??
                      null,
                  }),
              ...(body.sort_order ===
              undefined
                ? {}
                : {
                    sortOrder:
                      body.sort_order,
                  }),
            },
          );

        if (!descriptiveUpdate.ok) {
          return internal();
        }

        const descriptiveChanged =
          body.name !== undefined ||
          body.description !==
            undefined;

        /*
         * A Product rename is cosmetic and the database is
         * authoritative, so a failure here is logged and does
         * not fail the request.
         */
        if (
          descriptiveChanged &&
          service.stripe_product_id
        ) {
          const productUpdate =
            await updateProductDescriptive(
              {
                stripeProductId:
                  service.stripe_product_id,
                name:
                  body.name ??
                  service.name,
                description:
                  body.description ===
                  undefined
                    ? service.description
                    : body.description ??
                      null,
              },
            );

          if (!productUpdate.ok) {
            logStripeFailure(
              "product descriptive update",
              {
                serviceId,
                stripeProductId:
                  service.stripe_product_id,
              },
              productUpdate.failure,
            );
          }
        }

        if (
          intent.kind ===
          "clear_pricing"
        ) {
          if (
            service.stripe_payment_link_id
          ) {
            const deactivated =
              await deactivatePaymentLink(
                service.stripe_payment_link_id,
              );

            if (!deactivated.ok) {
              logStripeFailure(
                "payment link deactivation",
                {
                  serviceId,
                  stripePaymentLinkId:
                    service.stripe_payment_link_id,
                },
                deactivated.failure,
              );

              return {
                ok: false,
                code: "STRIPE_ERROR",
                message:
                  GENERIC_STRIPE_MESSAGE,
              };
            }
          }

          if (
            service.stripe_price_id
          ) {
            const deactivatedPrice =
              await deactivatePrice(
                service.stripe_price_id,
              );

            if (
              !deactivatedPrice.ok
            ) {
              logStripeFailure(
                "price deactivation",
                {
                  serviceId,
                  stripePriceId:
                    service.stripe_price_id,
                },
                deactivatedPrice.failure,
              );
            }
          }

          const cleared =
            await clearPricing(
              serviceId,
            );

          if (!cleared.ok) {
            return internal();
          }

          return reload(serviceId);
        }

        if (
          intent.kind ===
          "set_pricing"
        ) {
          const currentPricing =
            readPricing(service);

          const unchanged =
            currentPricing !== null &&
            samePricing(
              currentPricing,
              intent.pricing,
            ) &&
            service.stripe_payment_link_id !==
              null;

          if (!unchanged) {
            const previousLinkId =
              service.stripe_payment_link_id;

            const previousPriceId =
              service.stripe_price_id;

            const provisioned =
              await provisionPricing({
                service,
                pricing:
                  intent.pricing,
              });

            if (!provisioned.ok) {
              return provisioned.failure;
            }

            /*
             * Only now that the row references the replacement
             * is the superseded pair retired.
             */
            await retireSupersededResources(
              {
                serviceId,
                previousPaymentLinkId:
                  previousLinkId,
                previousPriceId:
                  previousPriceId,
              },
            );
          }
        }

        return reload(serviceId);
      },
    },
  );
};

/*
 * POST /api/admin/services/:id/activate
 *
 * Activation is always the final write, so a service is never
 * active without a confirmed working Payment Link.
 */
export const activateService = async (
  serviceId: string,
): Promise<AdminServiceResult> => {
  return withServiceLock<AdminServiceResult>(
    {
      serviceId,
      onMissing: notFound,
      onUnavailable: internal,
      onContended: contended,
      operation: async (service) => {
        /*
         * Already active is a no-op with no side effects, so an
         * active service is never reported as blocked and no
         * Stripe call is made.
         */
        if (service.is_active) {
          return {
            ok: true,
            service,
          };
        }

        const pricing =
          readPricing(service);

        if (!pricing) {
          return {
            ok: false,
            code: "INVALID_TRANSITION",
            message:
              "This service cannot be activated until it has complete pricing.",
            details: {
              reason:
                "pricing_required",
            },
          };
        }

        let current = service;

        let linkUsable = false;

        if (
          current.stripe_price_id &&
          current.stripe_payment_link_id
        ) {
          const link =
            await retrievePaymentLink(
              current.stripe_payment_link_id,
            );

          if (!link.ok) {
            logStripeFailure(
              "payment link retrieval",
              {
                serviceId,
                stripePaymentLinkId:
                  current.stripe_payment_link_id,
              },
              link.failure,
            );

            /*
             * A stored identifier Stripe no longer knows about is
             * stale, not fatal: the link is treated as unusable
             * and replaced below. Authentication, permission,
             * rate limit and network failures are real errors and
             * still fail the request, because retrying later is
             * the correct response to those.
             */
            if (
              !isResourceMissing(
                link.failure,
              )
            ) {
              return {
                ok: false,
                code: "STRIPE_ERROR",
                message:
                  GENERIC_STRIPE_MESSAGE,
              };
            }

            linkUsable = false;
          } else {
            linkUsable =
              paymentLinkMatchesPrice(
                link.value,
                current.stripe_price_id,
              );
          }
        }

        /*
         * Where the link is missing, inactive or mismatched the
         * resources are reconciled before activation. A
         * replacement never deletes its predecessor
         * (section 12.1.3).
         */
        if (!linkUsable) {
          const previousLinkId =
            current.stripe_payment_link_id;

          const previousPriceId =
            current.stripe_price_id;

          const provisioned =
            await provisionPricing({
              service: current,
              pricing,
            });

          if (!provisioned.ok) {
            return provisioned.failure;
          }

          current =
            provisioned.service;

          await retireSupersededResources(
            {
              serviceId,
              previousPaymentLinkId:
                previousLinkId,
              previousPriceId:
                previousPriceId,
            },
          );
        }

        /*
         * Activation is the natural repair point for a display
         * string that predates this formatter, or that an
         * interrupted provisioning left stale. A service is never
         * published advertising a price it does not charge.
         */
        const expectedDisplay =
          formatPriceDisplay(pricing);

        if (
          current.price_display !==
          expectedDisplay
        ) {
          const repaired =
            await persistPriceDisplay({
              serviceId,
              priceDisplay:
                expectedDisplay,
            });

          if (!repaired.ok) {
            return internal();
          }
        }

        const activated =
          await setActiveState({
            serviceId,
            isActive: true,
          });

        if (!activated.ok) {
          return internal();
        }

        return reload(serviceId);
      },
    },
  );
};

/*
 * POST /api/admin/services/:id/deactivate
 *
 * The Payment Link is deactivated first and its success is
 * required. The system must never report a service as inactive
 * while its stored Payment Link is still purchasable.
 */
export const deactivateService = async (
  serviceId: string,
): Promise<AdminServiceResult> => {
  return withServiceLock<AdminServiceResult>(
    {
      serviceId,
      onMissing: notFound,
      onUnavailable: internal,
      onContended: contended,
      operation: async (service) => {
        if (!service.is_active) {
          return {
            ok: true,
            service,
          };
        }

        if (
          service.stripe_payment_link_id
        ) {
          const deactivated =
            await deactivatePaymentLink(
              service.stripe_payment_link_id,
            );

          if (!deactivated.ok) {
            logStripeFailure(
              "payment link deactivation",
              {
                serviceId,
                stripePaymentLinkId:
                  service.stripe_payment_link_id,
              },
              deactivated.failure,
            );

            /*
             * is_active is left unchanged. The service stays
             * listed and purchasable, which is consistent, and
             * the operation is retried.
             */
            return {
              ok: false,
              code: "STRIPE_ERROR",
              message:
                GENERIC_STRIPE_MESSAGE,
            };
          }
        }

        const updated =
          await setActiveState({
            serviceId,
            isActive: false,
          });

        if (!updated.ok) {
          return internal();
        }

        /*
         * The Product and the Price are preserved
         * (section 12.2.4).
         */
        return reload(serviceId);
      },
    },
  );
};

/*
 * DELETE /api/admin/services/:id?confirm=true
 *
 * Confirmation is validated at the route, before this runs.
 */
export const removeService = async (
  serviceId: string,
): Promise<AdminServiceDeleteResult> => {
  return withServiceLock<AdminServiceDeleteResult>(
    {
      serviceId,
      onMissing: notFound,
      onUnavailable: internal,
      onContended: contended,
      operation: async (service) => {
        /*
         * An active service is refused rather than deactivated
         * here. Combining two destructive operations would let a
         * half-failed teardown strand a listed service with a
         * dead Payment Link.
         */
        if (service.is_active) {
          return {
            ok: false,
            code: "INVALID_TRANSITION",
            message:
              "Deactivate the service before deleting it.",
            details: {
              reason:
                "service_active",
            },
          };
        }

        const counts =
          await countServiceReferences(
            serviceId,
          );

        if (!counts.ok) {
          return internal();
        }

        if (counts.value.total > 0) {
          return {
            ok: false,
            code: "INVALID_TRANSITION",
            message:
              "This service is referenced by existing records and cannot be deleted. Deactivate it instead.",
            details: {
              reason: "service_in_use",
              references:
                counts.value
                  .references,
            },
          };
        }

        /*
         * Section 13.7: the Stripe identifiers are recorded
         * before the row is removed, so the resources remain
         * attributable after deletion.
         */
        console.info(
          "Admin service deletion teardown",
          {
            serviceId,
            stripeProductId:
              service.stripe_product_id,
            stripePriceId:
              service.stripe_price_id,
            stripePaymentLinkId:
              service.stripe_payment_link_id,
          },
        );

        if (
          service.stripe_payment_link_id
        ) {
          const link =
            await deactivatePaymentLink(
              service.stripe_payment_link_id,
            );

          if (!link.ok) {
            logStripeFailure(
              "payment link teardown",
              {
                serviceId,
                stripePaymentLinkId:
                  service.stripe_payment_link_id,
              },
              link.failure,
            );

            return {
              ok: false,
              code: "STRIPE_ERROR",
              message:
                GENERIC_STRIPE_MESSAGE,
            };
          }
        }

        if (service.stripe_price_id) {
          const price =
            await deactivatePrice(
              service.stripe_price_id,
            );

          if (!price.ok) {
            logStripeFailure(
              "price teardown",
              {
                serviceId,
                stripePriceId:
                  service.stripe_price_id,
              },
              price.failure,
            );

            return {
              ok: false,
              code: "STRIPE_ERROR",
              message:
                GENERIC_STRIPE_MESSAGE,
            };
          }
        }

        if (
          service.stripe_product_id
        ) {
          const product =
            await archiveProduct(
              service.stripe_product_id,
            );

          if (!product.ok) {
            logStripeFailure(
              "product archive",
              {
                serviceId,
                stripeProductId:
                  service.stripe_product_id,
              },
              product.failure,
            );

            return {
              ok: false,
              code: "STRIPE_ERROR",
              message:
                GENERIC_STRIPE_MESSAGE,
            };
          }
        }

        const deleted =
          await deleteServiceRow(
            serviceId,
          );

        if (!deleted.ok) {
          return internal();
        }

        return {
          ok: true,
          deleted: true,
          id: serviceId,
        };
      },
    },
  );
};
