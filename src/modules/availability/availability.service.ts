import { supabaseAdmin } from "../../lib/supabase.js";

type AvailabilityConsultant = {
  id: string;
  timezone: string;
  workingHours: Record<string, unknown>;
  minimumBookingNoticeHours: number;
};

export type ConsultantAvailabilityLookup =
  | {
      ok: true;
      consultant: AvailabilityConsultant;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "INTERNAL";
      message: string;
    };

export const getConsultantForAvailability = async (
  consultantId: string,
): Promise<ConsultantAvailabilityLookup> => {
  const {
    data: consultant,
    error: consultantError,
  } = await supabaseAdmin
    .from("consultants")
    .select(
      "id, timezone, working_hours_jsonb, minimum_booking_notice_hours, is_active",
    )
    .eq("id", consultantId)
    .eq("is_active", true)
    .maybeSingle();

  if (consultantError) {
    console.error(
      "Consultant availability lookup failed:",
      {
        code:
          consultantError.code,
        message:
          consultantError.message,
        details:
          consultantError.details,
        hint:
          consultantError.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL",
      message:
        "Unable to check availability right now.",
    };
  }

  if (!consultant) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "Consultant not found.",
    };
  }

  const workingHours =
    consultant.working_hours_jsonb &&
    typeof consultant.working_hours_jsonb ===
      "object" &&
    !Array.isArray(
      consultant.working_hours_jsonb,
    )
      ? (
          consultant.working_hours_jsonb as
            Record<string, unknown>
        )
      : {};

  return {
    ok: true,
    consultant: {
      id:
        consultant.id,
      timezone:
        consultant.timezone,
      workingHours,
      minimumBookingNoticeHours:
        consultant
          .minimum_booking_notice_hours,
    },
  };
};
