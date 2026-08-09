import { supabaseAdmin } from "../../lib/supabase.js";
import type { CreateDraftConsultationInput } from "./draft.schema.js";

type CreateDraftRepositoryInput = {
  clientProfileId: string;
  scheduledEndAt: string;
  /*
   * The consultant the SERVER resolved.
   *
   * Passed explicitly rather than read from draft.consultant_id,
   * because for a direct booking the request carries no id at all
   * — the consultant is whoever the slug's published page belongs
   * to. Taking it from the body here would reintroduce exactly the
   * browser-supplied identifier the route refuses to trust.
   */
  consultantId: string;
  /*
   * Snapshot values resolved by the caller: the platform price
   * from app_settings for a standard booking, or the EFFECTIVE
   * direct price for a direct booking.
   *
   * Passed in rather than read here so a single request resolves
   * settings once, and so the price written to the consultation is
   * demonstrably the one the route loaded and the one the page
   * displayed. Never supplied by the client: the draft request
   * body carries no price or currency field and none is accepted.
   */
  priceCents: number;
  currency: string;
  /*
   * Also the server's, and for the same reason. booking_source
   * decides which commission rules apply to the money, so a
   * request that could set it could choose its own split.
   */
  bookingSource:
    | "standard"
    | "direct_booking";
  draft: CreateDraftConsultationInput;
};

export type CreatedDraftConsultation = {
  consultationId: string;
  status: "draft";
  holdExpiresAt: string;
  priceCents: number;
  currency: string;
};

export type CreateDraftRepositoryResult =
  | {
      ok: true;
      draft: CreatedDraftConsultation;
    }
  | {
      ok: false;
      code: "SLOT_TAKEN" | "INTERNAL_ERROR";
      message: string;
      /*
       * Set only when the consultation row WAS created and then
       * could not be used. The caller must compensate for it -
       * otherwise the row sits in 'draft' holding a slot nobody
       * can book. Absent when nothing was inserted.
       */
      orphanedConsultationId?: string;
    };

type DraftRpcRow = {
  consultation_id: string;
  consultation_status: "draft";
  hold_expires_at: string;
  consultation_price_cents: number;
  consultation_currency: string;
};

/*
 * The five columns create_draft_consultation returns, named here
 * so a change to that contract is caught HERE rather than four
 * calls later.
 *
 * This check exists because it already failed once. Migration 045
 * replaced the RPC and returned two columns instead of five; the
 * missing hold_expires_at read as undefined, Date.parse gave NaN,
 * and the checkout capability's TTL calculation refused it - so
 * every booking answered 500 after its consultation row had
 * already been inserted, and the diagnosis was three files away
 * from the cause. A contract this load-bearing should not be
 * consumed on trust.
 */
const REQUIRED_DRAFT_COLUMNS = [
  "consultation_id",
  "consultation_status",
  "hold_expires_at",
  "consultation_price_cents",
  "consultation_currency",
] as const;

const missingDraftColumns = (
  row: Record<string, unknown>,
): string[] =>
  REQUIRED_DRAFT_COLUMNS.filter(
    (column) =>
      row[column] === undefined ||
      row[column] === null,
  );

export const createDraftConsultationRecord = async ({
  clientProfileId,
  scheduledEndAt,
  consultantId,
  priceCents,
  currency,
  bookingSource,
  draft,
}: CreateDraftRepositoryInput): Promise<CreateDraftRepositoryResult> => {
  const { data, error } = await supabaseAdmin.rpc(
    "create_draft_consultation",
    {
      p_client_profile_id: clientProfileId,
      p_consultant_id: consultantId,
      p_country_id: draft.country_id,
      p_scheduled_start_at: draft.start_at,
      p_scheduled_end_at: scheduledEndAt,
      p_client_timezone: draft.client_timezone,
      p_price_cents: priceCents,
      p_currency: currency,
      p_full_name: draft.intake.full_name,
      p_email: draft.intake.email,
      p_phone_whatsapp:
        draft.intake.phone_whatsapp,
      p_answers_jsonb: draft.intake.answers,
      p_booking_source: bookingSource,
    },
  );

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        code: "SLOT_TAKEN",
        message:
          "The selected consultation time is no longer available.",
      };
    }

    console.error(
      "Draft consultation RPC failed",
      {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        consultantId,
        clientProfileId,
        startAt: draft.start_at,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be created.",
    };
  }

  const rows = data as DraftRpcRow[] | null;
  const row = rows?.[0];

  if (!row) {
    console.error(
      "Draft consultation RPC returned no row",
      {
        consultantId,
        clientProfileId,
        startAt: draft.start_at,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be created.",
    };
  }

  const missing = missingDraftColumns(
    row as unknown as Record<
      string,
      unknown
    >,
  );

  if (missing.length > 0) {
    console.error(
      "Draft consultation RPC returned an unexpected shape",
      {
        missing,
        consultationId:
          row.consultation_id ?? null,
        consultantId,
        clientProfileId,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be created.",
      /*
       * The row exists even though it is unusable, so the caller
       * must still release the slot it is holding.
       */
      ...(typeof row.consultation_id ===
      "string"
        ? {
            orphanedConsultationId:
              row.consultation_id,
          }
        : {}),
    };
  }

  return {
    ok: true,
    draft: {
      consultationId: row.consultation_id,
      status: row.consultation_status,
      holdExpiresAt: row.hold_expires_at,
      priceCents:
        row.consultation_price_cents,
      currency: row.consultation_currency,
    },
  };
};

/*
 * Release the slot a failed booking is holding.
 *
 * The consultation row and the Redis checkout capability cannot
 * share a transaction, so there is a window in which the row
 * exists and the booking cannot proceed. This is the compensation
 * for that window.
 *
 * The RPC matches on id AND status = 'draft', so it cannot cancel
 * a booking whose payment preparation actually succeeded, and a
 * repeat call changes nothing. Nothing here decides that: the
 * predicate is in the database.
 *
 * Never throws. It runs on a path that is already failing, and a
 * cleanup problem must not replace the error the caller is about
 * to report.
 */
export type AbandonDraftResult = {
  cancelled: boolean;
  reason:
    | "cancelled"
    | "not_draft"
    | "not_found"
    | "cleanup_failed";
};

type AbandonDraftRpcRow = {
  consultation_id: string;
  cancelled: boolean;
  reason: "cancelled" | "not_draft" | "not_found";
};

export const abandonDraftConsultation =
  async (
    consultationId: string,
  ): Promise<AbandonDraftResult> => {
    try {
      const { data, error } =
        await supabaseAdmin.rpc(
          "abandon_draft_consultation",
          {
            p_consultation_id:
              consultationId,
          },
        );

      if (error) {
        console.error(
          "Draft consultation cleanup failed",
          {
            consultationId,
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          },
        );

        return {
          cancelled: false,
          reason: "cleanup_failed",
        };
      }

      const row = (
        data as AbandonDraftRpcRow[] | null
      )?.[0];

      if (!row) {
        console.error(
          "Draft consultation cleanup returned no row",
          { consultationId },
        );

        return {
          cancelled: false,
          reason: "cleanup_failed",
        };
      }

      return {
        cancelled: row.cancelled,
        reason: row.reason,
      };
    } catch (error) {
      console.error(
        "Draft consultation cleanup threw",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
      );

      return {
        cancelled: false,
        reason: "cleanup_failed",
      };
    }
  };
