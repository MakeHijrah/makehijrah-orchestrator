import { env } from "../config/env.js";

/*
 * GA4 Measurement Protocol sender.
 *
 * gtag() is a browser API and does not exist here, so a
 * server-side event is an HTTP POST to /mp/collect carrying a
 * measurement id and an API secret. The secret is created in
 * GA4 Admin under Data Streams and lives only in the environment.
 *
 * Analytics is OFF unless both variables are set. That is the
 * safe default: this code ships before the secret exists, and a
 * missing secret means "not configured", never a runtime error.
 *
 * Nothing here throws. Analytics is the least important thing
 * happening on any code path that calls it, and it must never be
 * the reason a payment, a webhook or a booking fails.
 */

const MEASUREMENT_PROTOCOL_URL =
  "https://www.google-analytics.com/mp/collect";

/*
 * Google drops an event that arrives more than 72 hours after the
 * timestamp it carries, and applies its own limits on name and
 * parameter length. The timeout is ours: a slow analytics
 * endpoint must not hold a Stripe webhook open.
 */
const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export type Ga4Item = {
  item_id: string;
  item_name?: string;
  item_category?: string;
  price?: number;
  quantity?: number;
};

export type Ga4Event = {
  name: string;
  params: Record<string, unknown>;
};

export type Ga4SendResult =
  | { ok: true; sent: true }
  | { ok: true; sent: false; reason: "not_configured" }
  | { ok: false; reason: string };

export const isGa4Configured = (): boolean =>
  Boolean(
    env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET,
  );

/*
 * client_id ties the event to a browser, and therefore to the
 * session and campaign that produced it. A server has no cookie
 * to read, so the caller supplies the id the browser recorded.
 *
 * When it is genuinely unavailable the event is still worth
 * sending — the revenue is real — but it will open a new,
 * unattributed session in GA4 rather than joining the visit that
 * earned it. The caller decides; this function only reports what
 * it was given.
 */
export const sendGa4Event = async ({
  clientId,
  event,
  userId,
}: {
  clientId: string;
  event: Ga4Event;
  userId?: string | null;
}): Promise<Ga4SendResult> => {
  if (!isGa4Configured()) {
    return {
      ok: true,
      sent: false,
      reason: "not_configured",
    };
  }

  const url =
    `${MEASUREMENT_PROTOCOL_URL}` +
    `?measurement_id=${encodeURIComponent(
      env.GA4_MEASUREMENT_ID as string,
    )}` +
    `&api_secret=${encodeURIComponent(
      env.GA4_API_SECRET as string,
    )}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(
        REQUEST_TIMEOUT_MILLISECONDS,
      ),
      body: JSON.stringify({
        client_id: clientId,
        ...(userId ? { user_id: userId } : {}),
        /*
         * Non-personalized: this is a server recording a
         * transaction, not an ad-targeting signal.
         */
        non_personalized_ads: true,
        events: [
          {
            name: event.name,
            params: event.params,
          },
        ],
      }),
    });

    /*
     * /mp/collect answers 204 with no body and reports nothing
     * about whether the event was accepted or silently discarded.
     * Only the transport can be checked here; correctness is
     * checked in GA4 DebugView.
     */
    if (!response.ok) {
      console.error(
        "GA4 Measurement Protocol request failed",
        {
          status: response.status,
          statusText: response.statusText,
          event: event.name,
        },
      );

      return {
        ok: false,
        reason: `http_${response.status}`,
      };
    }

    return { ok: true, sent: true };
  } catch (error) {
    console.error(
      "GA4 Measurement Protocol request threw",
      {
        event: event.name,
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );

    return { ok: false, reason: "network_error" };
  }
};
