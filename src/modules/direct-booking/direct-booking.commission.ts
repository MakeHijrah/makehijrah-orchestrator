/*
 * Direct booking commission TERMS, for display only.
 * PROJECT_LOCK Amendment 014.
 *
 * ============================================================
 * THIS FILE IS NOT THE FINANCIAL AUTHORITY. READ THIS FIRST.
 * ============================================================
 *
 * The authority for what a consultant is actually paid is, and
 * remains, the SQL ledger function:
 *
 *     public.record_direct_booking_earning   (migration 045)
 *
 * That function computes the split, writes the two ledger rows and
 * decides the money. Nothing in this file participates in that.
 *
 * What this file exists for is narrower: the consultant settings
 * screen shows a "Direct Booking Price ↔ You Earn" calculator, and
 * the frontend must not hardcode the percentages. So the settings
 * GET publishes the current terms, and the terms have to come from
 * somewhere on this side of the wire.
 *
 * THE BASE RATE has a real source and is read from it:
 * app_settings.consultation_consultant_commission_bps, the same row
 * record_consultation_earning and record_direct_booking_earning
 * both read. No copy exists.
 *
 * THE PREMIUM RATE does not. Its only authority today is a literal
 * inside record_direct_booking_earning:
 *
 *     c_premium_bps constant integer := 8000;
 *
 * It is not in app_settings, not in any table, and not derivable.
 * So publishing it means mirroring it here, and a mirror can drift
 * from the thing it mirrors.
 *
 * That drift is not left to discipline. MIGRATION_050_VERIFICATION
 * reads the function's own source text and FAILS if the literal is
 * no longer 8000. If somebody changes the ledger rate without
 * changing this constant, the verification breaks before anybody
 * sees a wrong number in a calculator.
 *
 * If the premium rate ever needs to become configurable, the right
 * change is to move it into app_settings and have the ledger
 * function read it - one authority, no mirror. That is a finance
 * change against a frozen baseline and needs its own approved scope
 * and regression. It is deliberately NOT done here.
 */

/*
 * Mirrors record_direct_booking_earning's c_premium_bps.
 * Display only. See the header.
 */
export const DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS = 8000;

/*
 * The terms a calculator needs, in integer minor units and basis
 * points, exactly as the ledger uses them.
 */
export type DirectBookingCommissionTerms = {
  /*
   * The platform's own consultation price. The boundary between
   * the base portion and the premium.
   *
   * Note this is the SAME underlying value as
   * minimum_direct_booking_price_cents on the settings view -
   * app_settings.consultation_price_cents - published under two
   * names because it answers two different questions: "what is the
   * lowest price I may set" and "where does my premium start".
   * They are one number and must never be allowed to diverge.
   */
  standardBookingPriceCents: number;

  /* The consultant's share of the base portion. 5000 bps today. */
  baseConsultantCommissionBps: number;

  /* The consultant's share of the premium above it. 8000 bps. */
  premiumConsultantCommissionBps: number;
};

/*
 * What a consultant earns at a given asking price.
 *
 * Reproduces record_direct_booking_earning's arithmetic exactly:
 * the effective price rule first, then least() to split base from
 * premium, then each component rounded on its own. Integer minor
 * units throughout — no floating-point money.
 *
 * This is the SAME formula the frontend calculator runs, published
 * here so the two cannot drift and so it can be tested against the
 * real ledger output rather than against itself.
 *
 * It is an ESTIMATE FOR DISPLAY. The ledger written at capture is
 * what a consultant is actually paid.
 */
export const estimateDirectBookingConsultantEarnings = ({
  priceCents,
  terms,
}: {
  priceCents: number;
  terms: DirectBookingCommissionTerms;
}): number => {
  /*
   * The effective price rule: a stale price below the platform
   * default is charged at the default, so the calculator must
   * estimate from what would actually be charged.
   */
  const charged = Math.max(
    priceCents,
    terms.standardBookingPriceCents,
  );

  const base = Math.min(
    charged,
    terms.standardBookingPriceCents,
  );

  const premium = charged - base;

  /*
   * Rounded per component, never on the blended total. PostgreSQL's
   * round() and JavaScript's Math.round() agree on positive halves,
   * and these are always positive.
   */
  return (
    Math.round(
      (base * terms.baseConsultantCommissionBps) / 10_000,
    ) +
    Math.round(
      (premium * terms.premiumConsultantCommissionBps) /
        10_000,
    )
  );
};
