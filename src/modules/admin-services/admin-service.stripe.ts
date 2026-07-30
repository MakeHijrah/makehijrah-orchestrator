/*
 * Stripe resource lifecycle for the admin service catalog.
 *
 * This is the only file in the module that imports the Stripe
 * client. PROJECT_LOCK Amendment 004 section 8 governs the rules
 * encoded here:
 *
 * - one Product per service, for the life of the service;
 * - Prices are immutable, so a pricing change creates a new one;
 * - a pricing change also creates a replacement Payment Link;
 * - nothing is ever deleted, only deactivated or archived.
 *
 * Section 14.3.11 requires Stripe error detail to be sanitised
 * before it leaves the orchestrator. Failures are returned as a
 * StripeFailure carrying the fields worth logging server-side;
 * callers log it and never place it in a response body.
 */

import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { env } from "../../config/env.js";
import { stripe } from "../../lib/stripe.js";
import type { StructuredPricing } from "./admin-service.schema.js";

export type StripeFailure = {
  type: string | null;
  code: string | null;
  requestId: string | null;
  message: string;
};

export type StripeCallResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      failure: StripeFailure;
    };

const readStringProperty = (
  source: unknown,
  key: string,
): string | null => {
  if (
    typeof source !== "object" ||
    source === null
  ) {
    return null;
  }

  const value = (
    source as Record<string, unknown>
  )[key];

  return typeof value === "string"
    ? value
    : null;
};

const toStripeFailure = (
  error: unknown,
): StripeFailure => {
  return {
    type: readStringProperty(
      error,
      "type",
    ),
    code: readStringProperty(
      error,
      "code",
    ),
    requestId: readStringProperty(
      error,
      "requestId",
    ),
    message:
      error instanceof Error
        ? error.message
        : "Unknown Stripe error",
  };
};

/*
 * Identifies the owning service, the application and the
 * environment on every object the orchestrator creates, so an
 * orphaned resource stays attributable (section 7.5).
 *
 * APP_ENV, not NODE_ENV: deployed environments run with
 * NODE_ENV=production regardless of which environment they are,
 * so NODE_ENV stamped staging-created objects as "production" and
 * made the tag useless for attribution.
 */
const buildMetadata = (
  serviceId: string,
): Stripe.MetadataParam => {
  return {
    makehijrah_service_id: serviceId,
    application:
      "makehijrah-orchestrator",
    environment: env.APP_ENV,
  };
};

/*
 * Identifies a pricing *generation*, not merely a set of pricing
 * values.
 *
 * The superseded Price and Payment Link identifiers are folded in
 * deliberately. A fingerprint over the pricing values alone is
 * stable across a revert: moving A -> B -> A reproduces the
 * original key, Stripe replays the original response inside its
 * 24 hour window, and the service ends up referencing the Price
 * and Payment Link that were deactivated when B superseded A.
 * Including the resources being replaced makes the second A a
 * distinct generation, so it gets fresh, active resources.
 *
 * Stability is preserved where it matters: a retry of the same
 * unfinished transition reads the same stored identifiers,
 * because the database is only updated once the new generation is
 * complete. The key therefore does not move under a retry.
 */
export const computeGenerationFingerprint =
  ({
    pricing,
    previousPriceId,
    previousPaymentLinkId,
  }: {
    pricing: StructuredPricing;
    previousPriceId: string | null;
    previousPaymentLinkId: string | null;
  }): string => {
    return createHash("sha256")
      .update(
        [
          pricing.billingType,
          pricing.recurringInterval ??
            "",
          String(pricing.priceCents),
          pricing.currency,
          previousPriceId ?? "",
          previousPaymentLinkId ?? "",
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 32);
  };

/*
 * Stripe rejects a reused idempotency key whose request
 * parameters differ. The Product key therefore has to cover the
 * parameters the Product is created with, or a name change
 * between a first attempt and its retry produces a hard
 * idempotency error that blocks provisioning for 24 hours.
 *
 * Description is normalised so that null, undefined and the empty
 * string all fold to the same token, matching the fact that
 * createProduct omits an empty description entirely.
 */
export const computeProductFingerprint =
  ({
    serviceId,
    name,
    description,
  }: {
    serviceId: string;
    name: string;
    description: string | null;
  }): string => {
    const metadata =
      buildMetadata(serviceId);

    return createHash("sha256")
      .update(
        [
          name,
          description ?? "",
          String(
            metadata.makehijrah_service_id,
          ),
          String(metadata.application),
          String(metadata.environment),
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 32);
  };

export const buildProductIdempotencyKey =
  ({
    serviceId,
    fingerprint,
  }: {
    serviceId: string;
    fingerprint: string;
  }): string =>
    `service-product-${serviceId}-${fingerprint}`;

/*
 * The attempt suffix is an escalation path, not a retry counter.
 *
 * It is only advanced when Stripe returns an inactive resource
 * for a key, which cannot happen for a fresh generation but is
 * possible if a historical key is somehow replayed. Escalation is
 * deterministic, so a repeated request walks the same sequence
 * and converges on the same resource rather than creating a new
 * one each time.
 */
export const buildPriceIdempotencyKey =
  ({
    serviceId,
    generation,
    attempt,
  }: {
    serviceId: string;
    generation: string;
    attempt: number;
  }): string =>
    `service-price-${serviceId}-${generation}${
      attempt > 0 ? `-r${attempt}` : ""
    }`;

export const buildLinkIdempotencyKey =
  ({
    serviceId,
    generation,
    attempt,
  }: {
    serviceId: string;
    generation: string;
    attempt: number;
  }): string =>
    `service-link-${serviceId}-${generation}${
      attempt > 0 ? `-r${attempt}` : ""
    }`;

/*
 * A stored identifier that Stripe no longer knows about is stale
 * rather than fatal: the correct response is to provision a
 * replacement. Every other Stripe failure - authentication,
 * permission, rate limiting, network - is a real error and must
 * not be mistaken for a missing resource.
 */
export const isResourceMissing = (
  failure: StripeFailure,
): boolean => {
  return (
    failure.code === "resource_missing"
  );
};

export const createProduct = async ({
  serviceId,
  name,
  description,
}: {
  serviceId: string;
  name: string;
  description: string | null;
}): Promise<
  StripeCallResult<Stripe.Product>
> => {
  try {
    const product =
      await stripe.products.create(
        {
          name,
          ...(description
            ? { description }
            : {}),
          metadata:
            buildMetadata(serviceId),
        },
        {
          idempotencyKey:
            buildProductIdempotencyKey({
              serviceId,
              fingerprint:
                computeProductFingerprint(
                  {
                    serviceId,
                    name,
                    description,
                  },
                ),
            }),
        },
      );

    return {
      ok: true,
      value: product,
    };
  } catch (error) {
    return {
      ok: false,
      failure:
        toStripeFailure(error),
    };
  }
};

/*
 * Section 8.1.2: a name or description change updates the
 * existing Product in place and never creates a second one.
 */
export const updateProductDescriptive =
  async ({
    stripeProductId,
    name,
    description,
  }: {
    stripeProductId: string;
    name: string;
    description: string | null;
  }): Promise<
    StripeCallResult<Stripe.Product>
  > => {
    try {
      const product =
        await stripe.products.update(
          stripeProductId,
          {
            name,
            ...(description
              ? { description }
              : {}),
          },
        );

      return {
        ok: true,
        value: product,
      };
    } catch (error) {
      return {
        ok: false,
        failure:
          toStripeFailure(error),
      };
    }
  };

/*
 * Section 8.2.5: a one-time service maps to a Price with no
 * recurrence, a recurring service to a Price whose interval
 * matches recurring_interval. The Price is never mutated
 * afterwards (section 8.2.1).
 */
export const createPrice = async ({
  serviceId,
  stripeProductId,
  pricing,
  generation,
  attempt,
}: {
  serviceId: string;
  stripeProductId: string;
  pricing: StructuredPricing;
  generation: string;
  attempt: number;
}): Promise<
  StripeCallResult<Stripe.Price>
> => {
  try {
    const price =
      await stripe.prices.create(
        {
          product: stripeProductId,
          unit_amount:
            pricing.priceCents,
          currency: pricing.currency,
          ...(pricing.billingType ===
            "recurring" &&
          pricing.recurringInterval
            ? {
                recurring: {
                  interval:
                    pricing.recurringInterval,
                },
              }
            : {}),
          metadata:
            buildMetadata(serviceId),
        },
        {
          idempotencyKey:
            buildPriceIdempotencyKey({
              serviceId,
              generation,
              attempt,
            }),
        },
      );

    return { ok: true, value: price };
  } catch (error) {
    return {
      ok: false,
      failure:
        toStripeFailure(error),
    };
  }
};

/*
 * Ordinary Stripe payment and subscription behaviour.
 *
 * Manual capture is never used here. It belongs exclusively to
 * the consultation Checkout flow, which this amendment leaves
 * untouched.
 *
 * The redirect target is fixed at ${APP_URL}/dashboard by section
 * 9.1. Section 9.2 forbids introducing any new frontend route.
 */
export const createPaymentLink = async ({
  serviceId,
  stripePriceId,
  generation,
  attempt,
}: {
  serviceId: string;
  stripePriceId: string;
  generation: string;
  attempt: number;
}): Promise<
  StripeCallResult<Stripe.PaymentLink>
> => {
  try {
    const paymentLink =
      await stripe.paymentLinks.create(
        {
          line_items: [
            {
              price: stripePriceId,
              quantity: 1,
            },
          ],
          after_completion: {
            type: "redirect",
            redirect: {
              url: `${env.APP_URL}/dashboard`,
            },
          },
          metadata:
            buildMetadata(serviceId),
        },
        {
          idempotencyKey:
            buildLinkIdempotencyKey({
              serviceId,
              generation,
              attempt,
            }),
        },
      );

    return {
      ok: true,
      value: paymentLink,
    };
  } catch (error) {
    return {
      ok: false,
      failure:
        toStripeFailure(error),
    };
  }
};

export const retrievePaymentLink =
  async (
    stripePaymentLinkId: string,
  ): Promise<
    StripeCallResult<Stripe.PaymentLink>
  > => {
    try {
      /*
       * line_items must be expanded explicitly. Without it the
       * field is absent from the response and the price
       * correspondence check below can never actually run.
       */
      const paymentLink =
        await stripe.paymentLinks.retrieve(
          stripePaymentLinkId,
          {
            expand: ["line_items"],
          },
        );

      return {
        ok: true,
        value: paymentLink,
      };
    } catch (error) {
      return {
        ok: false,
        failure:
          toStripeFailure(error),
      };
    }
  };

/*
 * Deactivation, never deletion (sections 8.2.4 and 8.3.2).
 */
export const deactivatePaymentLink =
  async (
    stripePaymentLinkId: string,
  ): Promise<
    StripeCallResult<Stripe.PaymentLink>
  > => {
    try {
      const paymentLink =
        await stripe.paymentLinks.update(
          stripePaymentLinkId,
          { active: false },
        );

      return {
        ok: true,
        value: paymentLink,
      };
    } catch (error) {
      return {
        ok: false,
        failure:
          toStripeFailure(error),
      };
    }
  };

export const deactivatePrice = async (
  stripePriceId: string,
): Promise<
  StripeCallResult<Stripe.Price>
> => {
  try {
    const price =
      await stripe.prices.update(
        stripePriceId,
        { active: false },
      );

    return { ok: true, value: price };
  } catch (error) {
    return {
      ok: false,
      failure:
        toStripeFailure(error),
    };
  }
};

/*
 * Section 8.1.3: a Product is never deleted. On service deletion
 * it is archived.
 */
export const archiveProduct = async (
  stripeProductId: string,
): Promise<
  StripeCallResult<Stripe.Product>
> => {
  try {
    const product =
      await stripe.products.update(
        stripeProductId,
        { active: false },
      );

    return {
      ok: true,
      value: product,
    };
  } catch (error) {
    return {
      ok: false,
      failure:
        toStripeFailure(error),
    };
  }
};

/*
 * A stored Payment Link is usable only when it is still active
 * and still sells the service's current Price. Anything else is
 * replaced rather than trusted (section 12.1.3).
 */
/*
 * A stored Payment Link is usable only when it is live and sells
 * the service's current Price.
 *
 * Absent line items are treated as unusable rather than as
 * "unknown, assume fine". The retrieval expands them explicitly,
 * so absence means the link is structurally not what this service
 * needs, and the safe response is to replace it. Assuming
 * correspondence here would let a link pointing at a superseded
 * Price survive activation unnoticed.
 */
export const paymentLinkMatchesPrice = (
  paymentLink: Stripe.PaymentLink,
  stripePriceId: string,
): boolean => {
  if (paymentLink.active === false) {
    return false;
  }

  const lineItems =
    paymentLink.line_items?.data;

  if (
    !lineItems ||
    lineItems.length === 0
  ) {
    return false;
  }

  return lineItems.some(
    (item) =>
      item.price?.id ===
      stripePriceId,
  );
};
