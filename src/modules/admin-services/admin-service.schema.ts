/*
 * Request validation for the admin service catalog.
 *
 * PROJECT_LOCK Amendment 004 section 14.3.4 requires strict
 * server-side validation in which unknown keys are rejected
 * rather than ignored, and section 14.3.10 forbids accepting any
 * Stripe identifier or price display from the client. Both are
 * enforced here, before any handler logic runs.
 */

import { z } from "zod";

import { MAX_RAW_HTML_LENGTH } from "../../lib/html-sanitizer.js";

export const SERVICE_BILLING_TYPES = [
  "one_time",
  "recurring",
] as const;

export const SERVICE_RECURRING_INTERVALS = [
  "month",
  "year",
] as const;

/*
 * Amendment 004 section 5.6. This set matches the
 * services_currency_check constraint added by migration 022, so
 * the application rejects exactly what the database would.
 */
export const SERVICE_CURRENCIES = [
  "usd",
  "gbp",
  "eur",
] as const;

export type ServiceBillingType =
  (typeof SERVICE_BILLING_TYPES)[number];

export type ServiceRecurringInterval =
  (typeof SERVICE_RECURRING_INTERVALS)[number];

export type ServiceCurrency =
  (typeof SERVICE_CURRENCIES)[number];

export type StructuredPricing = {
  billingType: ServiceBillingType;
  recurringInterval:
    | ServiceRecurringInterval
    | null;
  priceCents: number;
  currency: ServiceCurrency;
};

/*
 * Columns the orchestrator owns. A request carrying any of these
 * is rejected outright rather than having the key stripped, so a
 * client attempting to set a Stripe identifier gets a clear
 * failure instead of a silently ignored field.
 */
export const SERVER_OWNED_KEYS = [
  "id",
  "is_active",
  "price_display",
  "stripe_product_id",
  "stripe_price_id",
  "stripe_payment_link_id",
  "stripe_payment_link_url",
  "created_at",
  "updated_at",
] as const;

const PRICING_KEYS = [
  "billing_type",
  "recurring_interval",
  "price_cents",
  "currency",
] as const;

const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
};

export const findServerOwnedKeys = (
  body: unknown,
): string[] => {
  if (!isPlainObject(body)) {
    return [];
  }

  return SERVER_OWNED_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(
        body,
        key,
      ),
  );
};

const findProvidedPricingKeys = (
  body: unknown,
): string[] => {
  if (!isPlainObject(body)) {
    return [];
  }

  return PRICING_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(
      body,
      key,
    ),
  );
};

type PricingFields = {
  billing_type?:
    | ServiceBillingType
    | null;
  recurring_interval?:
    | ServiceRecurringInterval
    | null;
  price_cents?: number | null;
  currency?: ServiceCurrency | null;
};

/*
 * Mirrors services_billing_shape_check from migration 022.
 *
 * A service is fully unpriced or fully priced. Any value present
 * in the pricing group obliges the whole group to be coherent,
 * which is what makes partial pricing impossible to submit.
 */
const pricingShapeRefinement = (
  value: PricingFields,
  ctx: z.RefinementCtx,
): void => {
  const billingType =
    value.billing_type ?? null;

  const recurringInterval =
    value.recurring_interval ?? null;

  const priceCents =
    value.price_cents ?? null;

  const currency =
    value.currency ?? null;

  const anyPresent =
    billingType !== null ||
    recurringInterval !== null ||
    priceCents !== null ||
    currency !== null;

  if (!anyPresent) {
    return;
  }

  if (billingType === null) {
    ctx.addIssue({
      code: "custom",
      path: ["billing_type"],
      message:
        "billing_type is required when pricing is supplied.",
    });
  }

  if (priceCents === null) {
    ctx.addIssue({
      code: "custom",
      path: ["price_cents"],
      message:
        "price_cents is required when pricing is supplied.",
    });
  }

  if (currency === null) {
    ctx.addIssue({
      code: "custom",
      path: ["currency"],
      message:
        "currency is required when pricing is supplied.",
    });
  }

  if (
    billingType === "one_time" &&
    recurringInterval !== null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["recurring_interval"],
      message:
        "A one_time service must not carry a recurring_interval.",
    });
  }

  if (
    billingType === "recurring" &&
    recurringInterval === null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["recurring_interval"],
      message:
        "A recurring service requires a recurring_interval of month or year.",
    });
  }
};

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200);

const descriptionSchema = z
  .string()
  .trim()
  .max(2000)
  .nullish();

const sortOrderSchema = z
  .number()
  .int()
  .min(0)
  .optional();

/*
 * The consultant's share of this service's gross, in basis points
 * (migration 034, wired to the ledger by migration 040).
 *
 * Nullable with no default, and null is meaningful: it says no
 * rate has been agreed, which is not the same claim as 0%. Both
 * produce no consultant earning, but only one of them is a
 * decision.
 *
 * Bounded 0..10000 to match services_commission_bps_check, so the
 * application rejects exactly what the database would. Integer
 * basis points rather than a percentage float: money derived from
 * a binary float is money that is eventually wrong.
 *
 * Deliberately NOT in SERVER_OWNED_KEYS. It is not a Stripe
 * identifier and not a derived value — it is the one commercial
 * term about a service that only an administrator can decide, and
 * before this there was no way to set it at all.
 */
const commissionBpsSchema = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .nullish();

/*
 * Private post-purchase delivery instructions (migration 042).
 *
 * The bound here is the RAW, pre-sanitization one. It is
 * deliberately larger than the 20,000-character database
 * constraint because sanitizing shrinks input — a legitimate
 * document that ends up well under the stored limit can easily
 * arrive above it once a WYSIWYG editor has added its markup.
 * This bound exists to stop an enormous payload reaching the
 * HTML parser at all, not to police content length; the stored
 * length is enforced after sanitization, against the value the
 * database will actually see.
 *
 * `nullish` so the field carries three distinct meanings:
 * absent = leave unchanged, null = clear, string = replace.
 */
const postPurchaseInstructionsSchema = z
  .string()
  .max(MAX_RAW_HTML_LENGTH)
  .nullish();

const pricingFieldSchemas = {
  billing_type: z
    .enum(SERVICE_BILLING_TYPES)
    .nullish(),
  recurring_interval: z
    .enum(SERVICE_RECURRING_INTERVALS)
    .nullish(),
  price_cents: z
    .number()
    .int()
    .positive()
    .nullish(),
  currency: z
    .enum(SERVICE_CURRENCIES)
    .nullish(),
};

export const createServiceBodySchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
    sort_order: sortOrderSchema,
    consultant_commission_bps:
      commissionBpsSchema,
    post_purchase_instructions_html:
      postPurchaseInstructionsSchema,
    ...pricingFieldSchemas,
  })
  .strict()
  .superRefine(pricingShapeRefinement);

export const patchServiceBodySchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema,
    sort_order: sortOrderSchema,
    consultant_commission_bps:
      commissionBpsSchema,
    post_purchase_instructions_html:
      postPurchaseInstructionsSchema,
    ...pricingFieldSchemas,
  })
  .strict()
  .superRefine(pricingShapeRefinement);

export type CreateServiceBody =
  z.infer<
    typeof createServiceBodySchema
  >;

export type PatchServiceBody = z.infer<
  typeof patchServiceBodySchema
>;

export const serviceParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/*
 * Amendment 004 section 13.6 requires explicit administrator
 * confirmation. Only the exact string "true" is accepted, so
 * "TRUE", "1", "" and a missing parameter all fail, and the
 * strict object rejects any additional query key.
 */
export const deleteServiceQuerySchema =
  z
    .object({
      confirm: z.literal("true"),
    })
    .strict();

export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/*
 * Opaque, but restricted to an unreserved character set.
 *
 * Node joins a repeated request header into a single
 * comma-separated value rather than surfacing an array, so
 * excluding the comma is what actually makes a duplicated
 * Idempotency-Key detectable. Whitespace and control characters
 * are excluded for the same reason.
 */
export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const toStructuredPricing = (
  value: PricingFields,
): StructuredPricing | null => {
  const billingType =
    value.billing_type ?? null;

  const priceCents =
    value.price_cents ?? null;

  const currency =
    value.currency ?? null;

  if (
    billingType === null ||
    priceCents === null ||
    currency === null
  ) {
    return null;
  }

  return {
    billingType,
    recurringInterval:
      value.recurring_interval ?? null,
    priceCents,
    currency,
  };
};

const CURRENCY_SYMBOLS: Record<
  ServiceCurrency,
  string
> = {
  usd: "$",
  gbp: "£",
  eur: "€",
};

/*
 * The single source of price_display, required by PROJECT_LOCK
 * Amendment 004 section 6.2: where structured pricing exists,
 * price_display is generated server-side. It is never accepted
 * from a client and is not a database-generated column.
 *
 * Formatting is done by hand rather than through
 * Intl/toLocaleString. Locale-aware output varies with the host's
 * ICU data and default locale, which would make the stored string
 * depend on which server wrote it.
 *
 *   15000 usd one_time        -> $150
 *   1299  usd one_time        -> $12.99
 *   9900  gbp recurring month -> £99/month
 *   120000 eur recurring year -> €1,200/year
 */
export const formatPriceDisplay = (
  pricing: StructuredPricing,
): string => {
  const symbol =
    CURRENCY_SYMBOLS[pricing.currency];

  const whole = Math.floor(
    pricing.priceCents / 100,
  );

  const remainder =
    pricing.priceCents % 100;

  const groupedWhole = String(
    whole,
  ).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );

  const amount =
    remainder === 0
      ? groupedWhole
      : `${groupedWhole}.${String(
          remainder,
        ).padStart(2, "0")}`;

  const suffix =
    pricing.billingType ===
      "recurring" &&
    pricing.recurringInterval
      ? `/${pricing.recurringInterval}`
      : "";

  return `${symbol}${amount}${suffix}`;
};

export type PatchPricingIntent =
  | { kind: "descriptive_only" }
  | {
      kind: "set_pricing";
      pricing: StructuredPricing;
    }
  | { kind: "clear_pricing" }
  | {
      kind: "invalid";
      message: string;
    };

/*
 * Distinguishing "pricing omitted" from "pricing explicitly
 * cleared" needs the raw key set, because Zod cannot tell an
 * absent optional from one sent as null.
 *
 * Clearing requires all four pricing keys to be present and null.
 * A subset sent as null is a partial clear and is rejected, for
 * the same reason partial pricing is rejected on the way in.
 */
export const interpretPatchPricing = (
  rawBody: unknown,
  parsed: PatchServiceBody,
): PatchPricingIntent => {
  const providedKeys =
    findProvidedPricingKeys(rawBody);

  if (providedKeys.length === 0) {
    return {
      kind: "descriptive_only",
    };
  }

  const pricing =
    toStructuredPricing(parsed);

  if (pricing) {
    return {
      kind: "set_pricing",
      pricing,
    };
  }

  if (
    providedKeys.length !==
    PRICING_KEYS.length
  ) {
    return {
      kind: "invalid",
      message:
        "Clearing pricing requires billing_type, recurring_interval, price_cents and currency to all be sent as null.",
    };
  }

  return { kind: "clear_pricing" };
};
