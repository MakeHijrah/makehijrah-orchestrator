import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum([
      "development",
      "test",
      "staging",
      "production",
    ])
    .default("development"),

  /*
   * Operational deployment label, independent of NODE_ENV.
   *
   * NODE_ENV drives runtime behaviour and stays "production" on
   * deployed environments. APP_ENV records which environment a
   * deployment actually is, so an artefact created from a staging
   * deployment is not stamped "production".
   *
   * Deliberately has no default: an unset value would silently
   * mislabel every Stripe object it reaches, which is the exact
   * problem this variable exists to fix. It must be set
   * explicitly per environment.
   */
  APP_ENV: z.enum([
    "local",
    "staging",
    "production",
  ]),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(3000),

  SUPABASE_URL: z.string().url(),

  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  REDIS_URL: z.string().min(1),

  /*
   * Deprecated singular Stripe variables.
   *
   * Accepted so a deployment carrying the old values still boots,
   * but no runtime path reads them. PROJECT_LOCK Amendment 007
   * moved credential selection to the four mode-specific variables
   * below. Remove these from Railway once the new pair is proven.
   */
  STRIPE_SECRET_KEY: z
    .string()
    .optional(),

  STRIPE_WEBHOOK_SECRET: z
    .string()
    .optional(),

  /*
   * Mode-specific Stripe credentials. Amendment 007 section 5.3.
   *
   * All four are optional at the schema level because "is this
   * mode configured?" is defined as "are both of its variables
   * present and well-formed?". The superRefine below still
   * requires at least one complete pair, so the process cannot
   * start with no usable Stripe configuration at all.
   *
   * Values are never logged, returned, masked or echoed.
   */
  STRIPE_TEST_SECRET_KEY: z
    .string()
    .optional()
    .refine(
      (value) =>
        value === undefined ||
        value.startsWith("sk_test_"),
      {
        message:
          "STRIPE_TEST_SECRET_KEY must be a Stripe test secret key.",
      },
    ),

  STRIPE_TEST_WEBHOOK_SECRET: z
    .string()
    .optional()
    .refine(
      (value) =>
        value === undefined ||
        value.startsWith("whsec_"),
      {
        message:
          "STRIPE_TEST_WEBHOOK_SECRET must be a Stripe webhook signing secret.",
      },
    ),

  STRIPE_LIVE_SECRET_KEY: z
    .string()
    .optional()
    .refine(
      (value) =>
        value === undefined ||
        value.startsWith("sk_live_"),
      {
        message:
          "STRIPE_LIVE_SECRET_KEY must be a Stripe live secret key.",
      },
    ),

  STRIPE_LIVE_WEBHOOK_SECRET: z
    .string()
    .optional()
    .refine(
      (value) =>
        value === undefined ||
        value.startsWith("whsec_"),
      {
        message:
          "STRIPE_LIVE_WEBHOOK_SECRET must be a Stripe webhook signing secret.",
      },
    ),

  /*
   * Deprecated pricing defaults.
   *
   * Amendment 007 moved the runtime price and currency to
   * app_settings. These remain only as the migration-025 seed
   * record and for tests. No runtime path reads them.
   */
  DEFAULT_CONSULTATION_PRICE_CENTS: z.coerce
    .number()
    .int()
    .positive()
    .default(15000),

  DEFAULT_CURRENCY: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .transform((value) =>
      value.toLowerCase(),
    )
    .default("usd"),

  OAUTH_TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return (
            Buffer.from(
              value,
              "base64",
            ).length === 32
          );
        } catch {
          return false;
        }
      },
      {
        message:
          "OAUTH_TOKEN_ENCRYPTION_KEY must be a Base64-encoded 32-byte key.",
      },
    ),

  GOOGLE_CLIENT_ID: z.string().min(1),

  GOOGLE_CLIENT_SECRET: z.string().min(1),

  GOOGLE_REDIRECT_URI: z.string().url(),

  APP_URL: z.string().url(),

  OAUTH_STATE_SECRET: z.string().min(32),

  MANDRILL_API_KEY: z.string().min(1),

  MANDRILL_FROM_EMAIL: z.string().email(),

  MANDRILL_FROM_NAME: z.string().trim().min(1),
}).superRefine((value, context) => {
  /*
   * At least one complete Stripe mode must be configured, or no
   * payment path can work at all. Both may be configured, which is
   * the expected production state.
   */
  const testConfigured =
    Boolean(value.STRIPE_TEST_SECRET_KEY) &&
    Boolean(value.STRIPE_TEST_WEBHOOK_SECRET);

  const liveConfigured =
    Boolean(value.STRIPE_LIVE_SECRET_KEY) &&
    Boolean(value.STRIPE_LIVE_WEBHOOK_SECRET);

  if (!testConfigured && !liveConfigured) {
    context.addIssue({
      code: "custom",
      path: ["STRIPE_TEST_SECRET_KEY"],
      message:
        "At least one complete Stripe mode must be configured: both STRIPE_TEST_SECRET_KEY and STRIPE_TEST_WEBHOOK_SECRET, or both STRIPE_LIVE_SECRET_KEY and STRIPE_LIVE_WEBHOOK_SECRET.",
    });
  }
});

const parsed =
  envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment configuration:",
  );

  for (const issue of parsed.error.issues) {
    console.error(
      `- ${issue.path.join(".")}: ${issue.message}`,
    );
  }

  throw new Error(
    "Environment configuration is invalid",
  );
}

export const env = parsed.data;
