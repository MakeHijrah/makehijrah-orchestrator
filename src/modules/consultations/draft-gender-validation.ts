import { supabaseAdmin } from "../../lib/supabase.js";

type Gender =
  | "male"
  | "female";

type ConsultantGenderPreference =
  | Gender
  | "no_preference";

export type DraftGenderValidationResult =
  | {
      ok: true;
      consultantGender: Gender;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "VALIDATION_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

export const validateDraftConsultantGender =
  async ({
    consultantId,
    preferredConsultantGender,
  }: {
    consultantId: string;
    preferredConsultantGender:
      ConsultantGenderPreference;
  }): Promise<DraftGenderValidationResult> => {
    const {
      data,
      error,
    } = await supabaseAdmin
      .from("consultants")
      .select(
        "id, gender, is_active",
      )
      .eq(
        "id",
        consultantId,
      )
      .eq(
        "is_active",
        true,
      )
      .maybeSingle();

    if (error) {
      console.error(
        "Draft consultant gender lookup failed",
        {
          consultantId,
          code:
            error.code,
          message:
            error.message,
          details:
            error.details,
          hint:
            error.hint,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The selected consultant could not be verified.",
      };
    }

    if (!data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "The selected consultant is not available.",
      };
    }

    const gender =
      data.gender;

    if (
      gender !== "male" &&
      gender !== "female"
    ) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "The selected consultant is not currently available for public booking.",
      };
    }

    if (
      preferredConsultantGender !==
        "no_preference" &&
      preferredConsultantGender !==
        gender
    ) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "The selected consultant does not match your consultant preference.",
      };
    }

    return {
      ok: true,
      consultantGender:
        gender,
    };
  };
