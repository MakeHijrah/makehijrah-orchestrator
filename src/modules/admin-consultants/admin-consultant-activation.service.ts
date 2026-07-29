import { supabaseAdmin } from "../../lib/supabase.js";
import { normalizeWorkingHours } from "../availability/availability.slots.js";

/*
 * Machine-readable activation requirement labels.
 *
 * These values are part of the admin UI contract and are returned
 * in error.details.missing. Do not rename them.
 */
export type ActivationRequirement =
  | "timezone"
  | "working_hours"
  | "google_calendar";

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
      code: "ACTIVATION_BLOCKED";
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
  "id, timezone, working_hours_jsonb, is_active, available_for_general";

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
 * A consultant is only bookable if at least one weekday carries a
 * usable interval.
 *
 * normalizeWorkingHours is reused from the availability module so
 * this check follows the same weekday-key convention and the same
 * HH:MM validation that slot generation already applies. An
 * interval whose end is not after its start produces no slots, so
 * it does not count towards eligibility.
 */
export const hasUsableWorkingHours = (
  value: unknown,
): boolean => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const normalized =
    normalizeWorkingHours(
      value as Record<string, unknown>,
    );

  return Object.values(
    normalized,
  ).some((intervals) =>
    intervals.some(
      (interval) =>
        interval.end > interval.start,
    ),
  );
};

/*
 * Pure activation-precondition evaluation.
 *
 * Kept free of database access so the rules can be exercised in
 * isolation. Labels are emitted in a stable order.
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
  }): ActivationRequirement[] => {
    const missing: ActivationRequirement[] =
      [];

    if (
      !timezone ||
      timezone.trim() === ""
    ) {
      missing.push("timezone");
    }

    if (
      !hasUsableWorkingHours(
        workingHours,
      )
    ) {
      missing.push("working_hours");
    }

    if (
      !googleConnection ||
      googleConnection.revokedAt !==
        null ||
      !googleConnection.encryptedRefreshToken ||
      googleConnection.encryptedRefreshToken.trim() ===
        ""
    ) {
      missing.push(
        "google_calendar",
      );
    }

    return missing;
  };

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

    const missing =
      evaluateActivationPreconditions(
        {
          timezone:
            consultant.timezone,
          workingHours:
            consultant.working_hours_jsonb,
          googleConnection:
            connectionResult.connection,
        },
      );

    if (missing.length > 0) {
      return {
        ok: false,
        code: "ACTIVATION_BLOCKED",
        message:
          "This consultant cannot be activated yet.",
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
