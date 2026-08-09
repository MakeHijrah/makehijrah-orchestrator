import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Draft expiry. Migration 047.
 *
 * A draft consultation IS the slot hold — unique_reserved_consultant_
 * slot covers 'draft', so while the row sits there nobody else can
 * book that time. create_draft_consultation has always advertised a
 * thirty-minute hold and checkout has always refused a draft past
 * it, but until now nothing ever cancelled one. A visitor who
 * reached the payment step and closed the tab held that slot
 * indefinitely.
 *
 * Nothing here decides what is stale. The predicate — status =
 * 'draft' and created_at <= now() - interval '30 minutes' — lives
 * in the RPC, beside the definition of hold_expires_at, so the two
 * cannot drift. This layer forwards a batch size, reads the rows
 * that were cancelled, and reports them.
 */

const DEFAULT_BATCH_SIZE = 200;

export type ExpiredDraft = {
  consultationId: string;
  consultantId: string;
  scheduledStartAt: string;
};

export type ExpireDraftsResult =
  | {
      ok: true;
      expired: ExpiredDraft[];
      /*
       * True when the batch came back full, which means there may
       * be more behind it. The worker loops on this rather than
       * guessing.
       */
      batchFull: boolean;
    }
  | {
      ok: false;
      message: string;
    };

type ExpiredDraftRow = {
  consultation_id: string;
  consultant_id: string;
  scheduled_start_at: string;
};

export const expireStaleDraftConsultations =
  async (
    batchSize: number = DEFAULT_BATCH_SIZE,
  ): Promise<ExpireDraftsResult> => {
    const { data, error } =
      await supabaseAdmin.rpc(
        "expire_stale_draft_consultations",
        { p_limit: batchSize },
      );

    if (error) {
      console.error(
        "Draft expiry RPC failed",
        {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
        message: error.message,
      };
    }

    const rows =
      (data as ExpiredDraftRow[] | null) ??
      [];

    return {
      ok: true,
      expired: rows.map((row) => ({
        consultationId:
          row.consultation_id,
        consultantId: row.consultant_id,
        scheduledStartAt:
          row.scheduled_start_at,
      })),
      batchFull: rows.length >= batchSize,
    };
  };
