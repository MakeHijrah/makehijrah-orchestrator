import { supabaseAdmin } from "../../lib/supabase.js";
import { syncConsultationEarning } from "../finance/finance.service.js";

type CompletionConsultationRow = {
  id: string;
  consultant_id: string;
  status: string;
  scheduled_end_at: string;
  completed_at: string | null;
};

export type CompleteConsultationResult =
  | {
      ok: true;
      consultationId: string;
      status: string;
      completedAt: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INVALID_TRANSITION"
        | "INTERNAL_ERROR";
      message: string;
    };

const loadCompletionConsultation = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      consultation: CompletionConsultationRow;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultations")
      .select(
        "id, consultant_id, status, scheduled_end_at, completed_at",
      )
      .eq("id", consultationId)
      .maybeSingle();

  if (error) {
    console.error(
      "Completion consultation lookup failed",
      {
        consultationId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be loaded.",
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The consultation was not found.",
    };
  }

  return {
    ok: true,
    consultation:
      data as unknown as CompletionConsultationRow,
  };
};

const finalizeCompletion = async ({
  consultationId,
  consultantId,
  isAdmin,
}: {
  consultationId: string;
  consultantId: string | null;
  isAdmin: boolean;
}): Promise<
  | {
      ok: true;
      status: string;
      completedAt: string;
    }
  | {
      ok: false;
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin.rpc(
      "complete_consultation",
      {
        p_consultation_id:
          consultationId,
        p_consultant_id:
          consultantId,
        p_is_admin:
          isAdmin,
      },
    );

  if (error) {
    console.error(
      "Consultation completion RPC failed",
      {
        consultationId,
        consultantId,
        isAdmin,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      message:
        "The consultation completion could not be finalized.",
    };
  }

  const row =
    (
      data as unknown as
        | Array<{
            consultation_id: string;
            consultation_status: string;
            completed_at: string;
          }>
        | null
    )?.[0];

  if (
    !row ||
    !row.completed_at
  ) {
    return {
      ok: false,
      message:
        "The consultation completion returned no result.",
    };
  }

  return {
    ok: true,
    status:
      row.consultation_status,
    completedAt:
      row.completed_at,
  };
};

export const completeConsultation =
  async ({
    consultationId,
    consultantId,
    isAdmin,
  }: {
    consultationId: string;
    consultantId: string | null;
    isAdmin: boolean;
  }): Promise<CompleteConsultationResult> => {
    const consultationResult =
      await loadCompletionConsultation(
        consultationId,
      );

    if (!consultationResult.ok) {
      return consultationResult;
    }

    const { consultation } =
      consultationResult;

    if (
      !isAdmin &&
      consultation.consultant_id !==
        consultantId
    ) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          "You do not have permission to complete this consultation.",
      };
    }

    if (
      consultation.status ===
        "completed" &&
      consultation.completed_at
    ) {
      return {
        ok: true,
        consultationId:
          consultation.id,
        status:
          consultation.status,
        completedAt:
          consultation.completed_at,
      };
    }

    if (
      consultation.status !==
        "confirmed" &&
      consultation.status !==
        "captured"
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The consultation cannot be completed from its current status.",
      };
    }

    const scheduledEndAt =
      Date.parse(
        consultation.scheduled_end_at,
      );

    if (
      !Number.isFinite(
        scheduledEndAt,
      )
    ) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultation scheduled end time is invalid.",
      };
    }

    if (
      scheduledEndAt >
      Date.now()
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The consultation cannot be completed before its scheduled end time.",
      };
    }

    const finalizationResult =
      await finalizeCompletion({
        consultationId:
          consultation.id,
        consultantId:
          isAdmin
            ? null
            : consultantId,
        isAdmin,
      });

    if (!finalizationResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          finalizationResult.message,
      };
    }

    /*
     * Completion is half of what makes a consultation earning
     * withdrawable; capture is the other half, and it may have
     * happened already or not yet. syncConsultationEarning
     * settles whichever half is now true and is a no-op for the
     * other, so this call is correct in both orderings.
     *
     * Secondary to the completion itself. The consultation is
     * already completed and the caller must be told so; a
     * finance failure is logged and swallowed, and the capture
     * webhook will make the same call again.
     */
    try {
      const earning =
        await syncConsultationEarning(
          consultation.id,
        );

      if (
        !earning.recorded &&
        !earning.released &&
        earning.reason !== "not_captured" &&
        earning.reason !==
          "already_available"
      ) {
        console.warn(
          "Consultation earning unchanged after completion",
          {
            consultationId:
              consultation.id,
            reason: earning.reason,
          },
        );
      }
    } catch (error) {
      console.error(
        "Consultation earning sync threw after completion",
        {
          consultationId: consultation.id,
          message:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
      );
    }

    return {
      ok: true,
      consultationId:
        consultation.id,
      status:
        finalizationResult.status,
      completedAt:
        finalizationResult.completedAt,
    };
  };
