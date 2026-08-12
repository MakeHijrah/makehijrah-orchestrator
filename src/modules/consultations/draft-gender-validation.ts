import { supabaseAdmin } from "../../lib/supabase.js";

type Gender =
  | "male"
  | "female";

type ConsultantGenderPreference =
  | Gender
  | "no_preference";

/*
 * Machine-readable rejection reasons returned in
 * error.details.reason. These values are part of the booking UI
 * contract. Do not rename them.
 */
export type DraftConsultantRejectionReason =
  | "consultant_not_general"
  | "consultant_country_mismatch"
  | "consultant_direct_booking_only";

const DESTINATION_MESSAGE =
  "The selected consultant is not available for this destination.";

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
      reason?: DraftConsultantRejectionReason;
    };

/*
 * Consultant eligibility for a draft consultation.
 *
 * Covers identity, activation, gender, gender preference and
 * destination capability. It runs before slot validation, before
 * the booking client is resolved, before the draft row is
 * inserted and before any checkout capability exists, so a
 * consultant who cannot serve the requested destination is
 * rejected without a single external side effect.
 *
 * The file keeps its original name: the call site is a single
 * import and renaming the module would churn history for no gain.
 */
export const validateDraftConsultantGender =
  async ({
    consultantId,
    countryId,
    preferredConsultantGender,
    bookingSource,
  }: {
    consultantId: string;
    countryId: string | null;
    preferredConsultantGender:
      ConsultantGenderPreference;
    /*
     * Which flow is asking. A direct-booking-only consultant is
     * refused for 'standard' and unaffected for 'direct_booking' -
     * the whole point of the preference is that their own link
     * keeps working. Amendment 014.
     */
    bookingSource:
      | "standard"
      | "direct_booking";
  }): Promise<DraftGenderValidationResult> => {
    const {
      data,
      error,
    } = await supabaseAdmin
      .from("consultants")
      .select(
        "id, gender, is_active, available_for_general, direct_booking_only",
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

    /*
     * DIRECT-BOOKING-ONLY, checked before anything else about the
     * consultant.
     *
     * The RLS narrowing in migration 050 already keeps them out of
     * the /consultation chooser, so a standard request naming them
     * has arrived from a stale list, a cached page or a
     * hand-crafted call. Invisible is not the same as unbookable,
     * and this is what makes it unbookable.
     *
     * Direct bookings pass straight through: the consultant is
     * refusing the platform's chooser, not their own clients.
     */
    if (
      bookingSource === "standard" &&
      (data as { direct_booking_only?: boolean })
        .direct_booking_only === true
    ) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "The selected consultant is not available for this booking.",
        reason: "consultant_direct_booking_only",
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

    /*
     * General consultation.
     *
     * A null country_id is the only signal for a general
     * consultation, per the locked data model. The consultant
     * must have opted in.
     */
    if (countryId === null) {
      if (
        data.available_for_general !==
        true
      ) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: DESTINATION_MESSAGE,
          reason:
            "consultant_not_general",
        };
      }

      return {
        ok: true,
        consultantGender: gender,
      };
    }

    /*
     * Country consultation.
     *
     * The country must exist and still be active, and the
     * consultant must be assigned to it. Both failures return the
     * same reason and the same user-facing copy: whether a
     * destination is unknown, retired, or simply unserved by this
     * consultant is not something a public caller needs to
     * distinguish.
     */
    const {
      data: country,
      error: countryError,
    } = await supabaseAdmin
      .from("countries")
      .select("id, is_active")
      .eq("id", countryId)
      .maybeSingle();

    if (countryError) {
      console.error(
        "Draft consultation country lookup failed",
        {
          consultantId,
          countryId,
          code: countryError.code,
          message:
            countryError.message,
          details:
            countryError.details,
          hint: countryError.hint,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The selected consultant could not be verified.",
      };
    }

    if (
      !country ||
      country.is_active !== true
    ) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: DESTINATION_MESSAGE,
        reason:
          "consultant_country_mismatch",
      };
    }

    const {
      data: assignment,
      error: assignmentError,
    } = await supabaseAdmin
      .from("consultant_countries")
      .select("consultant_id")
      .eq(
        "consultant_id",
        consultantId,
      )
      .eq("country_id", countryId)
      .maybeSingle();

    if (assignmentError) {
      console.error(
        "Draft consultation country assignment lookup failed",
        {
          consultantId,
          countryId,
          code: assignmentError.code,
          message:
            assignmentError.message,
          details:
            assignmentError.details,
          hint: assignmentError.hint,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The selected consultant could not be verified.",
      };
    }

    if (!assignment) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: DESTINATION_MESSAGE,
        reason:
          "consultant_country_mismatch",
      };
    }

    return {
      ok: true,
      consultantGender:
        gender,
    };
  };
