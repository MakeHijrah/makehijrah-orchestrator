import {
  evaluateProfileCompleteness,
  isValidTimezone,
  isValidMinimumNotice,
  type GoogleConnectionState,
  type MergedProfileState,
  type ProfileRequirement,
} from "./consultant-profile.completeness.js";
import {
  loadActiveCountryIds,
  loadConsultantByProfileId,
  loadCountryIds,
  loadGoogleConnection,
  saveConsultantProfile,
  type ConsultantProfileRow,
  type RpcMarker,
} from "./consultant-profile.repository.js";
import type { ConsultantProfileInput } from "./consultant-profile.schema.js";
import { validateWorkingHours } from "./consultant-profile.working-hours.js";

/*
 * Consultant profile save service. PROJECT_LOCK Amendment 008.
 *
 * Three modes, one write path. The RPC is the transactional
 * referee and re-checks everything; this layer exists to reject
 * early with precise, machine-readable reasons rather than an
 * opaque database marker, and to evaluate rules the database
 * cannot see - notably the Google Calendar connection.
 */

export type ConsultantProfileView = {
  id: string;
  profile_id: string;
  full_name: string | null;
  avatar_url: string | null;
  gender: string | null;
  headline: string | null;
  bio: string | null;
  timezone: string | null;
  minimum_booking_notice_hours: number;
  available_for_general: boolean;
  country_ids: string[];
  working_hours: unknown;
  onboarding_completed_at:
    | string
    | null;
};

export type ConsultantProfileResult =
  | {
      ok: true;
      consultant: ConsultantProfileView;
    }
  | {
      ok: false;
      code: "NOT_FOUND";
      message: string;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      message: string;
      issues: string[];
    }
  | {
      ok: false;
      code: "CONSULTANT_PROFILE_INCOMPLETE";
      message: string;
      missing: ProfileRequirement[];
    }
  | {
      ok: false;
      code: "INVALID_TRANSITION";
      message: string;
      marker: RpcMarker;
    }
  | {
      ok: false;
      code: "CONSULTANT_GENDER_IMMUTABLE";
      message: string;
    }
  | {
      ok: false;
      code: "CONSULTANT_COUNTRY_INVALID";
      message: string;
      issues: string[];
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

const internalError =
  (): ConsultantProfileResult => ({
    ok: false,
    code: "INTERNAL_ERROR",
    message:
      "The consultant profile could not be saved.",
  });

/*
 * null preserves the stored value. undefined (field omitted) is
 * treated identically, which is what makes a partial body safe.
 */
const merge = <T>(
  supplied: T | null | undefined,
  stored: T,
): T =>
  supplied === null ||
  supplied === undefined
    ? stored
    : supplied;

const toView = ({
  consultant,
  countryIds,
}: {
  consultant: ConsultantProfileRow;
  countryIds: string[];
}): ConsultantProfileView => ({
  id: consultant.id,
  profile_id: consultant.profile_id,
  full_name: consultant.full_name,
  avatar_url: consultant.avatar_url,
  gender: consultant.gender,
  headline: consultant.headline,
  bio: consultant.bio,
  timezone: consultant.timezone,
  minimum_booking_notice_hours:
    consultant.minimum_booking_notice_hours,
  available_for_general:
    consultant.available_for_general,
  country_ids: countryIds,
  working_hours:
    consultant.working_hours_jsonb,
  onboarding_completed_at:
    consultant.onboarding_completed_at,
});

const markerToResult = (
  marker: RpcMarker | null,
): ConsultantProfileResult => {
  switch (marker) {
    case "CONSULTANT_GENDER_IMMUTABLE":
      return {
        ok: false,
        code: "CONSULTANT_GENDER_IMMUTABLE",
        message:
          "Consultant gender cannot be changed after onboarding is completed.",
      };

    case "CONSULTANT_COUNTRY_INVALID":
      return {
        ok: false,
        code: "CONSULTANT_COUNTRY_INVALID",
        message:
          "One or more supplied countries do not exist or are not active.",
        issues: [],
      };

    case "CONSULTANT_GENDER_INVALID":
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "The supplied gender is invalid.",
        issues: [
          "gender must be male or female.",
        ],
      };

    case "CONSULTANT_PROFILE_NOT_FOUND":
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "The consultant profile was not found.",
      };

    case "CONSULTANT_PROFILE_MODE_INVALID":
    case "CONSULTANT_ONBOARDING_ALREADY_COMPLETED":
    case "CONSULTANT_ONBOARDING_INCOMPLETE":
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          marker ===
          "CONSULTANT_ONBOARDING_INCOMPLETE"
            ? "Onboarding must be completed before the profile can be updated."
            : marker ===
                "CONSULTANT_ONBOARDING_ALREADY_COMPLETED"
              ? "Onboarding has already been completed for this consultant."
              : "The requested profile save mode is invalid.",
        marker,
      };

    default:
      return internalError();
  }
};

export const saveProfileForConsultant =
  async ({
    profileId,
    input,
  }: {
    profileId: string;
    input: ConsultantProfileInput;
  }): Promise<ConsultantProfileResult> => {
    /*
     * Ownership. The consultant is resolved from the authenticated
     * profile; the request body carries no identifier and none
     * would be accepted (the schema is strict).
     */
    const consultantResult =
      await loadConsultantByProfileId(
        profileId,
      );

    if (!consultantResult.ok) {
      return internalError();
    }

    const consultant =
      consultantResult.data;

    if (!consultant) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "No consultant profile exists for this account.",
      };
    }

    const storedCountriesResult =
      await loadCountryIds(
        consultant.id,
      );

    if (!storedCountriesResult.ok) {
      return internalError();
    }

    const storedCountryIds =
      storedCountriesResult.data;

    const isComplete =
      consultant.onboarding_completed_at !==
      null;

    /*
     * Mode against onboarding state, checked here so the caller
     * gets a precise answer without a database round trip. The RPC
     * enforces the same rule and remains the referee.
     */
    if (
      input.mode === "update" &&
      !isComplete
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "Onboarding must be completed before the profile can be updated.",
        marker:
          "CONSULTANT_ONBOARDING_INCOMPLETE",
      };
    }

    if (
      (input.mode === "draft" ||
        input.mode === "submit") &&
      isComplete
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "Onboarding has already been completed for this consultant.",
        marker:
          "CONSULTANT_ONBOARDING_ALREADY_COMPLETED",
      };
    }

    /*
     * Gender immutability is enforced here as well as in the RPC.
     * Relying on the database marker alone would mean the API
     * behaviour depends on an exception string.
     */
    if (
      input.mode === "update" &&
      input.gender !== null &&
      input.gender !== undefined &&
      input.gender !==
        consultant.gender
    ) {
      return {
        ok: false,
        code: "CONSULTANT_GENDER_IMMUTABLE",
        message:
          "Consultant gender cannot be changed after onboarding is completed.",
      };
    }

    const issues: string[] = [];

    /*
     * Working hours. Validated whenever supplied, in every mode -
     * a draft may be partial but it may not be malformed.
     */
    let normalizedWorkingHours:
      | unknown
      | null = null;

    if (
      input.working_hours !== null &&
      input.working_hours !== undefined
    ) {
      const validation =
        validateWorkingHours(
          input.working_hours,
        );

      if (!validation.ok) {
        issues.push(
          ...validation.issues,
        );
      } else {
        normalizedWorkingHours =
          validation.workingHours;
      }
    }

    /*
     * Shape-level timezone and notice checks apply in every mode.
     * Completeness is separate: a draft may omit them entirely,
     * but it may not supply nonsense.
     */
    if (
      input.timezone !== null &&
      input.timezone !== undefined &&
      !isValidTimezone(input.timezone)
    ) {
      issues.push(
        "timezone must be a valid IANA timezone.",
      );
    }

    if (
      input.minimum_booking_notice_hours !==
        null &&
      input.minimum_booking_notice_hours !==
        undefined &&
      !isValidMinimumNotice(
        input.minimum_booking_notice_hours,
      )
    ) {
      issues.push(
        "minimum_booking_notice_hours is out of range.",
      );
    }

    /*
     * Countries. Validated before the RPC so the caller learns how
     * many identifiers were rejected rather than receiving an
     * opaque marker. Duplicates collapse here as well as in the
     * RPC.
     */
    let requestedCountryIds:
      | string[]
      | null = null;

    if (
      input.country_ids !== null &&
      input.country_ids !== undefined
    ) {
      requestedCountryIds = [
        ...new Set(input.country_ids),
      ];

      if (
        requestedCountryIds.length > 0
      ) {
        const activeResult =
          await loadActiveCountryIds(
            requestedCountryIds,
          );

        if (!activeResult.ok) {
          return internalError();
        }

        const active = new Set(
          activeResult.data,
        );

        const rejected =
          requestedCountryIds.filter(
            (id) => !active.has(id),
          );

        if (rejected.length > 0) {
          return {
            ok: false,
            code: "CONSULTANT_COUNTRY_INVALID",
            message:
              "One or more supplied countries do not exist or are not active.",
            issues: [
              `${rejected.length} supplied country identifier(s) do not exist or are not active.`,
            ],
          };
        }
      }
    }

    if (issues.length > 0) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "The consultant profile request is invalid.",
        issues,
      };
    }

    /*
     * Merged final state. Completeness is always evaluated against
     * what the row will look like AFTER the save, never against
     * the request alone.
     */
    const effectiveCountryIds =
      requestedCountryIds ??
      storedCountryIds;

    const mergedWorkingHours =
      normalizedWorkingHours ??
      consultant.working_hours_jsonb;

    /*
     * Structural completeness is required for submit and for an
     * active consultant's update. The two differ only in whether a
     * working Google connection is part of that bar.
     *
     * Amendment 003: an active consultant whose Google connection
     * has since degraded must still be able to save an otherwise
     * complete profile. Blocking their edits would punish them for
     * an external failure they cannot fix from this endpoint, and
     * would leave them no route back to a good state.
     */
    const completenessContext:
      | "onboarding_submit"
      | "active_profile_update"
      | null =
      input.mode === "submit"
        ? "onboarding_submit"
        : input.mode === "update" &&
            consultant.is_active
          ? "active_profile_update"
          : null;

    if (completenessContext) {
      /*
       * Read only when the context requires it. An active update
       * never consults Google, so it never fails on a Google
       * lookup either.
       */
      let googleConnection: GoogleConnectionState | null =
        null;

      if (
        completenessContext ===
        "onboarding_submit"
      ) {
        const googleResult =
          await loadGoogleConnection(
            consultant.id,
          );

        if (!googleResult.ok) {
          return internalError();
        }

        googleConnection =
          googleResult.data;
      }

      const merged: MergedProfileState =
        {
          avatarUrl: merge(
            input.avatar_url,
            consultant.avatar_url,
          ),
          fullName: merge(
            input.full_name,
            consultant.full_name,
          ),
          gender:
            input.mode === "submit"
              ? merge(
                  input.gender,
                  consultant.gender,
                )
              : consultant.gender,
          headline: merge(
            input.headline,
            consultant.headline,
          ),
          bio: merge(
            input.bio,
            consultant.bio,
          ),
          timezone: merge(
            input.timezone,
            consultant.timezone,
          ),
          minimumBookingNoticeHours:
            merge(
              input.minimum_booking_notice_hours,
              consultant.minimum_booking_notice_hours,
            ),
          availableForGeneral: merge(
            input.available_for_general,
            consultant.available_for_general,
          ),
          countryIds:
            effectiveCountryIds,
          workingHours:
            mergedWorkingHours,
          googleConnection,
        };

      const missing =
        evaluateProfileCompleteness(
          merged,
          completenessContext,
        );

      if (missing.length > 0) {
        return {
          ok: false,
          code: "CONSULTANT_PROFILE_INCOMPLETE",
          message:
            "The consultant profile is incomplete.",
          missing,
        };
      }
    }

    const saveResult =
      await saveConsultantProfile({
        consultantId: consultant.id,
        mode: input.mode,
        fullName:
          input.full_name ?? null,
        avatarUrl:
          input.avatar_url ?? null,
        gender: input.gender ?? null,
        headline:
          input.headline ?? null,
        bio: input.bio ?? null,
        timezone:
          input.timezone ?? null,
        minimumBookingNoticeHours:
          input.minimum_booking_notice_hours ??
          null,
        availableForGeneral:
          input.available_for_general ??
          null,
        countryIds:
          requestedCountryIds,
        workingHours:
          normalizedWorkingHours,
      });

    if (!saveResult.ok) {
      return markerToResult(
        saveResult.marker,
      );
    }

    /*
     * Return the authoritative persisted state, re-read rather
     * than assembled from the request.
     */
    const finalResult =
      await loadConsultantByProfileId(
        profileId,
      );

    if (
      !finalResult.ok ||
      !finalResult.data
    ) {
      return internalError();
    }

    const finalCountries =
      await loadCountryIds(
        consultant.id,
      );

    if (!finalCountries.ok) {
      return internalError();
    }

    return {
      ok: true,
      consultant: toView({
        consultant: finalResult.data,
        countryIds:
          finalCountries.data,
      }),
    };
  };
