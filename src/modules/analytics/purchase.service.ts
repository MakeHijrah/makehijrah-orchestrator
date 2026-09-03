import {
  isGa4Configured,
  sendGa4Event,
  type Ga4Item,
} from "../../lib/ga4.js";

/*
 * The GA4 `purchase` event for a consultation.
 *
 * Fired server-side from the Stripe webhook on CAPTURE, not on
 * authorization. A consultation can be authorized and then
 * declined by the consultant or time out, and never captured, so
 * reporting authorization as revenue would report money the
 * platform did not collect. Capture is also what the finance
 * ledger credits, so GA and the ledger agree by construction.
 *
 * Everything the event needs travels in Stripe PaymentIntent
 * metadata, written at checkout. That is deliberate: Amendment
 * 004 section 10.3.3 holds the webhook path to RPC calls and
 * forbids direct table reads, and metadata is already how the
 * webhook learns the consultation id.
 */

export type PurchaseEventInput = {
  consultationId: string;
  amountMinor: number;
  currency: string;
  gaClientId: string | null;
  consultantId: string | null;
  consultantName: string | null;
  destination: string | null;
};

export type PurchaseEventOutcome = {
  sent: boolean;
  reason:
    | "sent"
    | "not_configured"
    | "invalid_amount"
    | "send_failed";
  clientIdSource: "browser" | "server_fallback";
};

/*
 * A client_id the browser never supplied.
 *
 * Derived from the consultation id rather than random, so a
 * redelivered webhook that reaches this twice reuses the same id
 * instead of opening a second phantom session. The event still
 * counts the revenue; it simply cannot join the visit that earned
 * it, which is why ga_client_id_source is sent alongside — the
 * size of the unattributed slice is then measurable in GA rather
 * than invisible.
 */
const fallbackClientId = (
  consultationId: string,
): string => {
  const digits = consultationId.replace(/\D/g, "");

  return `${digits.slice(0, 10) || "0"}.${
    digits.slice(10, 20) || "0"
  }`;
};

/*
 * Minor units to major. Every currency this platform accepts —
 * usd, gbp, eur — has two decimal places. A zero-decimal currency
 * such as JPY would need its own exponent before it could be
 * priced.
 */
const toMajorUnits = (amountMinor: number): number =>
  Math.round(amountMinor) / 100;

/*
 * Whether a webhook delivery should report a purchase.
 *
 * Extracted so the rule can be tested on its own, because it is
 * the part that is easy to get wrong and expensive when wrong:
 * fire on the wrong event and revenue is misreported, fire on a
 * redelivery and it is double-counted.
 *
 * `processed && !alreadyProcessed` means this delivery is the one
 * that did the work. The payments table's unique stripe_event_id
 * is what guarantees exactly one delivery can satisfy it.
 */
export const shouldSendPurchaseEvent = ({
  eventType,
  consultationId,
  processed,
  alreadyProcessed,
}: {
  eventType: string;
  consultationId: string | null;
  processed: boolean;
  alreadyProcessed: boolean;
}): boolean =>
  eventType === "payment_intent.succeeded" &&
  Boolean(consultationId) &&
  processed &&
  !alreadyProcessed;

export const sendConsultationPurchaseEvent = async ({
  consultationId,
  amountMinor,
  currency,
  gaClientId,
  consultantId,
  consultantName,
  destination,
}: PurchaseEventInput): Promise<
  PurchaseEventOutcome
> => {
  const clientIdSource: "browser" | "server_fallback" =
    gaClientId ? "browser" : "server_fallback";

  if (!isGa4Configured()) {
    return {
      sent: false,
      reason: "not_configured",
      clientIdSource,
    };
  }

  if (
    !Number.isFinite(amountMinor) ||
    amountMinor <= 0
  ) {
    console.error(
      "GA4 purchase skipped: the captured amount is not usable",
      { consultationId, amountMinor },
    );

    return {
      sent: false,
      reason: "invalid_amount",
      clientIdSource,
    };
  }

  const value = toMajorUnits(amountMinor);

  /*
   * item_id is the consultant, so GA reports which consultant
   * converts. It is omitted rather than faked when checkout did
   * not record one, because an item without an id is not a valid
   * GA4 item.
   */
  const items: Ga4Item[] = consultantId
    ? [
        {
          item_id: consultantId,
          ...(consultantName
            ? { item_name: consultantName }
            : {}),
          ...(destination
            ? { item_category: destination }
            : {}),
          price: value,
          quantity: 1,
        },
      ]
    : [];

  const result = await sendGa4Event({
    clientId:
      gaClientId ?? fallbackClientId(consultationId),
    event: {
      name: "purchase",
      params: {
        /* Dedupe anchor: one purchase per consultation. */
        transaction_id: consultationId,
        value,
        currency: currency.toUpperCase(),
        ga_client_id_source: clientIdSource,
        ...(items.length > 0 ? { items } : {}),
      },
    },
  });

  if (!result.ok) {
    return {
      sent: false,
      reason: "send_failed",
      clientIdSource,
    };
  }

  return {
    sent: result.sent,
    reason: result.sent ? "sent" : "not_configured",
    clientIdSource,
  };
};
