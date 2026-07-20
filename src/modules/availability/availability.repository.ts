import { supabaseAdmin } from "../../lib/supabase.js";
import type { BusyInterval } from "./availability.conflicts.js";

const RESERVED_STATUSES = [
  "draft",
  "payment_authorized",
  "pending_acceptance",
  "confirmed",
  "captured",
] as const;

type ReservedConsultationRow = {
  scheduled_start_at: string;
  scheduled_end_at: string;
};

export type ReservedConsultationsResult =
  | {
      ok: true;
      intervals: BusyInterval[];
    }
  | {
      ok: false;
      message: string;
    };

export const getReservedConsultationIntervals = async (
  consultantId: string,
  from: string,
  to: string,
): Promise<ReservedConsultationsResult> => {
  const { data, error } = await supabaseAdmin
    .from("consultations")
    .select("scheduled_start_at, scheduled_end_at")
    .eq("consultant_id", consultantId)
    .in("status", [...RESERVED_STATUSES])
    .lt("scheduled_start_at", to)
    .gt("scheduled_end_at", from);

  if (error) {
    console.error("Reserved consultation lookup failed:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    return {
      ok: false,
      message: "Unable to check existing consultation conflicts.",
    };
  }

  const rows = (data ?? []) as ReservedConsultationRow[];

  return {
    ok: true,
    intervals: rows.map((row) => ({
      start_at: row.scheduled_start_at,
      end_at: row.scheduled_end_at,
    })),
  };
};
