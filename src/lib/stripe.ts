import Stripe from "stripe";
import { env } from "../config/env.js";
import { getSettings } from "../modules/settings/settings.provider.js";

/*
 * Stripe client provider. PROJECT_LOCK Amendment 007 sections 5.2
 * to 5.8.
 *
 * There is deliberately no module-level active client and no
 * `export const stripe` alias. A single active client cannot be
 * correct once the platform can switch modes: capturing a payment
 * that was authorised in test mode must always reach the test
 * account, whatever the current global mode happens to be.
 *
 * Two facts keep this simple:
 * - A client for a given mode is permanently valid for that mode,
 *   so the client cache never needs invalidating.
 * - Only the settings cache needs invalidating on a mode change,
 *   which the admin update path does explicitly.
 *
 * Credentials are read from Railway environment variables and are
 * never logged, returned, masked or echoed anywhere.
 */

export type StripeMode = "test" | "live";

const STRIPE_CLIENT_OPTIONS = {
  maxNetworkRetries: 2,
  timeout: 20_000,
} as const;

const clients = new Map<
  StripeMode,
  Stripe
>();

type ModeCredentials = {
  secretKey: string | undefined;
  webhookSecret: string | undefined;
};

const credentialsFor = (
  mode: StripeMode,
): ModeCredentials =>
  mode === "test"
    ? {
        secretKey:
          env.STRIPE_TEST_SECRET_KEY,
        webhookSecret:
          env.STRIPE_TEST_WEBHOOK_SECRET,
      }
    : {
        secretKey:
          env.STRIPE_LIVE_SECRET_KEY,
        webhookSecret:
          env.STRIPE_LIVE_WEBHOOK_SECRET,
      };

/*
 * A mode is configured only when both of its variables are
 * present. This is the sole source of the configured booleans
 * returned by the admin settings endpoint.
 */
export const isStripeModeConfigured = (
  mode: StripeMode,
): boolean => {
  const { secretKey, webhookSecret } =
    credentialsFor(mode);

  return (
    Boolean(secretKey) &&
    Boolean(webhookSecret)
  );
};

export const configuredStripeModes =
  (): StripeMode[] =>
    (["test", "live"] as const).filter(
      isStripeModeConfigured,
    );

/*
 * The webhook signing secret for a mode.
 *
 * Returned only to the webhook verifier, which passes it straight
 * to Stripe's signature check. It is never logged or surfaced.
 */
export const stripeWebhookSecretFor = (
  mode: StripeMode,
): string | undefined =>
  credentialsFor(mode).webhookSecret;

export class StripeModeNotConfiguredError extends Error {
  public readonly mode: StripeMode;

  constructor(mode: StripeMode) {
    super(
      `Stripe ${mode} mode is not configured.`,
    );

    this.name =
      "StripeModeNotConfiguredError";
    this.mode = mode;
  }
}

/*
 * Lazily construct and cache one client per mode. At most two
 * clients exist for the lifetime of the process.
 */
export const getStripeClient = (
  mode: StripeMode,
): Stripe => {
  const cached = clients.get(mode);

  if (cached) {
    return cached;
  }

  const { secretKey } =
    credentialsFor(mode);

  if (!secretKey) {
    throw new StripeModeNotConfiguredError(
      mode,
    );
  }

  const client = new Stripe(
    secretKey,
    STRIPE_CLIENT_OPTIONS,
  );

  clients.set(mode, client);

  return client;
};

/*
 * The client for the currently active mode, used only where a new
 * Stripe object is being created: consultation PaymentIntents and
 * the service catalog.
 *
 * Never use this to operate on an existing PaymentIntent. Those
 * paths must select by consultations.stripe_mode instead.
 */
export const getActiveStripeMode =
  async (): Promise<StripeMode> => {
    const settings =
      await getSettings();

    return settings.stripe_mode;
  };

export const getActiveStripeClient =
  async (): Promise<Stripe> =>
    getStripeClient(
      await getActiveStripeMode(),
    );
