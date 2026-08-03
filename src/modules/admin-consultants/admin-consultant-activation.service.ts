import { supabaseAdmin } from "../../lib/supabase.js";
import {
  evaluateProfileCompleteness,
  type ProfileRequirement,
} from "../consultant-profile/consultant-profile.completeness.js";
import {
  loadConsultantByProfileId,
  loadCountryIds,
} from "../consultant-profile/consultant-profile.repository.js";
import { hasUsableWorkingHours } from "../consultant-profile/consultant-profile.working-hours.js";

/*
 * Machine-readable activation requirement labels.
 *
 * PROJECT_LOCK Amendment 008 replaced the original three-label set
 * with the shared profile requirement identifiers, so activation
 * and consultant submission can never disagree about what a
 * complete profile is. The three original labels are a subset of
 * the shared set, so existing consumers keep working.
 *
 * These values are part of the admin UI contract and are returned
 * in error.details.missing. Do not rename them.
 */
export type ActivationRequirement =
  | ProfileRequirement
  | "onboarding_completed";

export type AdminConsultantView = {
  id: string;
  is_active: boolean;
  timezone: string | null;
  available_for_general: boolean;
};

export type GoogleConnectionState = {
  revokedAt: string | null;
  encryptedRefreshToken: string | null;
};

export type AdminConsultantActivationResult =
  | {
      ok: true;
      consultant: AdminConsultantView;
    }
  | {
      ok: false;
      code: "NOT_FOUND";
      message: string;
    }
  | {
      ok: false;
      code: "CONSULTANT_PROFILE_INCOMPLETE";
      message: string;
      missing: ActivationRequirement[];
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

type ConsultantRow = {
  id: string;
  profile_id: string;
  timezone: string | null;
  working_hours_jsonb: unknown;
  is_active: boolean;
  available_for_general: boolean;
};

type OAuthConnectionRow = {
  revoked_at: string | null;
  encrypted_refresh_token: string | null;
};

const CONSULTANT_COLUMNS =
  "id, profile_id, timezone, working_hours_jsonb, is_active, available_for_general";

const toConsultantView = (
  row: ConsultantRow,
): AdminConsultantView => ({
  id: row.id,
  is_active: row.is_active,
  timezone: row.timezone,
  available_for_general:
    row.available_for_general,
});

/*
 * Re-exported from the shared working-hours validator so existing
 * importers keep working. The implementation now lives with the
 * consultant profile rules, which is the only place the convention
 * is defined.
 */
export { hasUsableWorkingHours };

/*
 * Retained for backwards compatibility with existing callers and
 * tests. Delegates to the shared evaluator, restricted to the
 * inputs this signature carries.
 */
export const evaluateActivationPreconditions =
  ({
    timezone,
    workingHours,
    googleConnection,
  }: {
    timezone: string | null;
    workingHours: unknown;
    googleConnection:
      | GoogleConnectionState
      | null;
  }): ActivationRequirement[] =>
    evaluateProfileCompleteness({
      avatarUrl: "present",
      fullName: "present",
      gender: "male",
      headline: "present",
      bio: "present",
      timezone,
      minimumBookingNoticeHours: 24,
      availableForGeneral: true,
      countryIds: [],
      workingHours,
      googleConnection,
    }, "admin_activation");

const loadConsultant = async (
  consultantId: string,
): Promise<
  | {
      ok: true;
      consultant: ConsultantRow | null;
    }
  | {
      ok: false;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultants")
      .select(CONSULTANT_COLUMNS)
      .eq("id", consultantId)
      .maybeSingle();

  if (error) {
    console.error(
      "Admin consultant lookup failed",
      {
        consultantId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
    };
  }

  return {
    ok: true,
    consultant:
      data as ConsultantRow | null,
  };
};

const loadGoogleConnection = async (
  consultantId: string,
): Promise<
  | {
      ok: true;
      connection: GoogleConnectionState | null;
    }
  | {
      ok: false;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("oauth_connections")
      .select(
        "revoked_at, encrypted_refresh_token",
      )
      .eq(
        "consultant_id",
        consultantId,
      )
      .eq("provider", "google")
      .maybeSingle();

  if (error) {
    console.error(
      "Admin consultant Google connection lookup failed",
      {
        consultantId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
    };
  }

  const row =
    data as OAuthConnectionRow | null;

  return {
    ok: true,
    connection: row
      ? {
          revokedAt:
            row.revoked_at,
          encryptedRefreshToken:
            row.encrypted_refresh_token,
        }
      : null,
  };
};

/*
 * Flip is_active on a single consultant.
 *
 * Only is_active is written. No other column, row, or table is
 * touched, and the write runs through the service-role client so
 * no authenticated RLS permission for is_active is required.
 */
const setConsultantActiveState =
  async ({
    consultantId,
    isActive,
  }: {
    consultantId: string;
    isActive: boolean;
  }): Promise<
    | {
        ok: true;
        consultant: ConsultantRow | null;
      }
    | {
        ok: false;
      }
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .update({
          is_active: isActive,
        })
        .eq("id", consultantId)
        .select(CONSULTANT_COLUMNS)
        .maybeSingle();

    if (error) {
      console.error(
        "Admin consultant activation state update failed",
        {
          consultantId,
          isActive,
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
      };
    }

    return {
      ok: true,
      consultant:
        data as ConsultantRow | null,
    };
  };

export const activateConsultant =
  async (
    consultantId: string,
  ): Promise<AdminConsultantActivationResult> => {
    const lookupResult =
      await loadConsultant(
        consultantId,
      );

    if (!lookupResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant could not be activated.",
      };
    }

    const { consultant } =
      lookupResult;

    if (!consultant) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "Consultant not found.",
      };
    }

    /*
     * Already active is a no-op. Preconditions are not re-checked
     * so an active consultant is never reported as blocked.
     */
    if (consultant.is_active) {
      return {
        ok: true,
        consultant:
          toConsultantView(
            consultant,
          ),
      };
    }

    const connectionResult =
      await loadGoogleConnection(
        consultantId,
      );

    if (!connectionResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant could not be activated.",
      };
    }

    /*
     * Amendment 008: activation now applies the SAME completeness
     * evaluator a consultant had to satisfy to submit. Before this,
     * activation checked only timezone, working hours and Google,
     * so a consultant could be activated with no avatar, no
     * headline, no bio and no booking capability.
     *
     * The full profile is re-read here rather than reusing the
     * narrow activation row, because completeness spans
     * profiles.full_name, profiles.avatar_url and the country
     * assignments as well as the consultant row.
     */
    const fullProfileResult =
      await loadConsultantByProfileId(
        consultant.profile_id,
      );

    if (
      !fullProfileResult.ok ||
      !fullProfileResult.data
    ) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant could not be activated.",
      };
    }

    const countryResult =
      await loadCountryIds(
        consultantId,
      );

    if (!countryResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant could not be activated.",
      };
    }

    const profile =
      fullProfileResult.data;

    const missing: ActivationRequirement[] =
      [];

    /*
     * Onboarding must have been completed. Activating a consultant
     * who never submitted would bypass submission entirely.
     */
    if (
      profile.onboarding_completed_at ===
      null
    ) {
      missing.push(
        "onboarding_completed",
      );
    }

    missing.push(
      ...evaluateProfileCompleteness({
        avatarUrl: profile.avatar_url,
        fullName: profile.full_name,
        gender: profile.gender,
        headline: profile.headline,
        bio: profile.bio,
        timezone: profile.timezone,
        minimumBookingNoticeHours:
          profile.minimum_booking_notice_hours,
        availableForGeneral:
          profile.available_for_general,
        countryIds:
          countryResult.data,
        workingHours:
          profile.working_hours_jsonb,
        googleConnection:
          connectionResult.connection,
      }, "admin_activation"),
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

    const updateResult =
      await setConsultantActiveState(
        {
          consultantId,
          isActive: true,
        },
      );

    if (
      !updateResult.ok ||
      !updateResult.consultant
    ) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant could not be activated.",
      };
    }

    return {
      ok: true,
      consultant: toConsultantView(
        updateResult.consultant,
      ),
    };
  };

export const deactivateConsultant =
  async (
    consultantId: string,
  ): Promise<AdminConsultantActivationResult> => {
    const lookupResult =
      await loadConsultant(
        consultantId,
      );

    if (!lookupResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant could not be deactivated.",
      };
    }

    const { consultant } =
      lookupResult;

    if (!consultant) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "Consultant not found.",
      };
    }

    /*
     * Already inactive is a no-op.
     *
     * Deactivation never touches the OAuth connection, working
     * hours, country assignments, consultations, general
     * availability, or the profile role.
     */
    if (!consultant.is_active) {
      return {
        ok: true,
        consultant:
          toConsultantView(
            consultant,
          ),
      };
    }

    const updateResult =
      await setConsultantActiveState(
        {
          consultantId,
          isActive: false,
        },
      );

    if (
      !updateResult.ok ||
      !updateResult.consultant
    ) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant could not be deactivated.",
      };
    }

    return {
      ok: true,
      consultant: toConsultantView(
        updateResult.consultant,
      ),
    };
  };
