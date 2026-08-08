import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * A client's own service purchases.
 *
 * public.service_purchases is closed to clients at the database
 * layer and stays that way: migration 034's policy names only the
 * attributed consultant and an admin, and its own comment records
 * that the client's exclusion is STRUCTURAL — no policy on any
 * finance table mentions client_profile_id, so there is no clause
 * to loosen by accident later. Nothing here changes that.
 *
 * What this file adds is a narrow orchestrator read: the service
 * role selects the rows, and the projection below is the only
 * thing a client ever sees of that table. The alternative —
 * widening RLS or adding a client-facing view — would have made
 * the whole row reachable and left the column list as the only
 * defence.
 *
 * The projection is written as an explicit column list rather
 * than a select-star-and-omit, so a column added to
 * service_purchases later is invisible here until somebody
 * deliberately adds it. It fails closed, which is the same
 * property migration 034 part E relies on for services.
 */

export type ClientServicePurchase = {
  id: string;
  service_id: string;
  consultation_id: string | null;
  status: string;
  gross_amount_minor: number;
  currency: string;
  purchased_at: string;
  billing_type: string;
  recurring_interval: string | null;
  billing_period_sequence: number;
};

/*
 * The columns a client may see, and nothing else.
 *
 * Deliberately absent, each for its own reason:
 *   attributed_consultant_id   who earns from this sale is not
 *                              the buyer's business
 *   stripe_*                   payment-processor identifiers are
 *                              never sent to a browser
 *   refunded_amount_minor      internal finance accounting
 *   service_request_id         operational workflow, not needed
 *                              to render a purchase
 *   stripe_mode                deployment detail
 */
const CLIENT_PURCHASE_COLUMNS = [
  "id",
  "service_id",
  "consultation_id",
  "status",
  "gross_amount_minor",
  "currency",
  "purchased_at",
  "billing_type",
  "recurring_interval",
  "billing_period_sequence",
].join(", ");

/*
 * A bound, stated rather than assumed.
 *
 * service_purchases carries no index on client_profile_id
 * (migration 034 indexed the consultant and the service, which is
 * what the finance paths need), so this read is a scan. The table
 * is small today and a client's own purchases are naturally few —
 * but a recurring service produces one row per renewal, so the
 * set does grow. 200 is roughly sixteen years of monthly billing:
 * generous enough that no real client is truncated, small enough
 * that a pathological account cannot make the dashboard expensive.
 */
const MAX_CLIENT_PURCHASES = 200;

export type ClientServicePurchasesResult =
  | {
      ok: true;
      purchases: ClientServicePurchase[];
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

export const listServicePurchasesForClient =
  async ({
    clientProfileId,
  }: {
    clientProfileId: string;
  }): Promise<ClientServicePurchasesResult> => {
    /*
     * clientProfileId comes from the bearer token in the route.
     * There is no parameter on this endpoint through which
     * another client could be named, so reading somebody else's
     * purchases is unrepresentable rather than merely forbidden —
     * the same shape the payout request endpoint uses.
     */
    const { data, error } = await supabaseAdmin
      .from("service_purchases")
      .select(CLIENT_PURCHASE_COLUMNS)
      .eq("client_profile_id", clientProfileId)
      /*
       * Newest first. The id is a stable tie-break so two
       * purchases sharing a timestamp — a plausible outcome of one
       * webhook delivery batch — always come back in the same
       * order rather than an arbitrary one.
       */
      .order("purchased_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_CLIENT_PURCHASES);

    if (error) {
      console.error(
        "Client service purchase lookup failed",
        {
          clientProfileId,
          code: error.code,
          message: error.message,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "Your service purchases could not be loaded.",
      };
    }

    return {
      ok: true,
      purchases: (data ??
        []) as unknown as ClientServicePurchase[],
    };
  };
