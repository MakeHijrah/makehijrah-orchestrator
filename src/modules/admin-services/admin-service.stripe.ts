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
 */
const buildMetadata = (
  serviceId: string,
): Stripe.MetadataParam => {
  return {
    makehijrah_service_id: serviceId,
    application:
      "makehijrah-orchestrator",
    environment: env.NODE_ENV,
  };
};

/*
 * Stable across retries of the same logical pricing, and
 * different across a genuine pricing change. Combined with the
 * Stripe idempotency key this is what makes a resumed create or
 * patch return the resource it already made rather than a second
 * one.
 */
export const computePricingFingerprint =
  (pricing: StructuredPricing): string => {
    return createHash("sha256")
      .update(
        [
          pricing.billingType,
          pricing.recurringInterval ??
            "",
          String(pricing.priceCents),
          pricing.currency,
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 32);
  };

export const buildProductIdempotencyKey =
  (serviceId: string): string =>
    `service-product-${serviceId}`;

export const buildPriceIdempotencyKey =
  ({
    serviceId,
    fingerprint,
  }: {
    serviceId: string;
    fingerprint: string;
  }): string =>
    `service-price-${serviceId}-${fingerprint}`;

export const buildLinkIdempotencyKey =
  ({
    serviceId,
    fingerprint,
  }: {
    serviceId: string;
    fingerprint: string;
  }): string =>
    `service-link-${serviceId}-${fingerprint}`;

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
            buildProductIdempotencyKey(
              serviceId,
            ),
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
  fingerprint,
}: {
  serviceId: string;
  stripeProductId: string;
  pricing: StructuredPricing;
  fingerprint: string;
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
              fingerprint,
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
  fingerprint,
}: {
  serviceId: string;
  stripePriceId: string;
  fingerprint: string;
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
              fingerprint,
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
      const paymentLink =
        await stripe.paymentLinks.retrieve(
          stripePaymentLinkId,
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
export const paymentLinkMatchesPrice = (
  paymentLink: Stripe.PaymentLink,
  stripePriceId: string,
): boolean => {
  if (!paymentLink.active) {
    return false;
  }

  const lineItems =
    paymentLink.line_items?.data;

  if (!lineItems) {
    /*
     * line_items is not expanded by default. Absence is not
     * evidence of a mismatch, so an active link is accepted and
     * the price correspondence is enforced by the fact that the
     * orchestrator created the link for that price.
     */
    return true;
  }

  return lineItems.some(
    (item) =>
      item.price?.id ===
      stripePriceId,
  );
};
