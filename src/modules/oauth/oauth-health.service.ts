import { supabaseAdmin } from "../../lib/supabase.js";
import { getGoogleAccessToken } from "./google-access-token.js";

const HEALTH_CHECK_INTERVAL_MS =
  24 * 60 * 60 * 1000;

const DEFAULT_BATCH_SIZE = 25;

type OAuthHealthCandidateRow = {
  consultant_id: string;
};

export type ListOAuthHealthCandidatesResult =
  | {
      ok: true;
      consultantIds: string[];
    }
  | {
      ok: false;
      message: string;
    };

export type ProcessOAuthHealthCheckResult =
  | {
      ok: true;
      action: "remove";
      outcome:
        | "healthy"
        | "revoked"
        | "error"
        | "inactive"
        | "missing";
    }
  | {
      ok: false;
      action: "retry";
      message: string;
    };

const updateConnectionHealth = async ({
  consultantId,
  values,
}: {
  consultantId: string;
  values: Record<string, string | null>;
}): Promise<boolean> => {
  const { error } = await supabaseAdmin
    .from("oauth_connections")
    .update({
      ...values,
      updated_at: new Date().toISOString(),
    })
    .eq("consultant_id", consultantId)
    .eq("provider", "google");

  if (error) {
    console.error("OAuth health-state update failed", {
      consultantId,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    return false;
  }

  return true;
};

export const listOAuthHealthCandidates = async (
  limit = DEFAULT_BATCH_SIZE,
): Promise<ListOAuthHealthCandidatesResult> => {
  const dueBefore =
    new Date(
      Date.now() -
        HEALTH_CHECK_INTERVAL_MS,
    ).toISOString();

  const {
    data: activeConsultants,
    error: consultantError,
  } = await supabaseAdmin
    .from("consultants")
    .select("id")
    .eq("is_active", true);

  if (consultantError) {
    console.error(
      "OAuth health active-consultant lookup failed",
      {
        code: consultantError.code,
        message: consultantError.message,
        details: consultantError.details,
        hint: consultantError.hint,
      },
    );

    return {
      ok: false,
      message:
        "Active consultants could not be loaded.",
    };
  }

  const activeConsultantIds =
    (activeConsultants ?? [])
      .map((row) => row.id as string)
      .filter(Boolean);

  if (activeConsultantIds.length === 0) {
    return {
      ok: true,
      consultantIds: [],
    };
  }

  const {
    data: connectionData,
    error: connectionError,
  } = await supabaseAdmin
    .from("oauth_connections")
    .select("consultant_id")
    .eq("provider", "google")
    .in(
      "consultant_id",
      activeConsultantIds,
    )
    .or(
      `last_health_check_at.is.null,last_health_check_at.lt.${dueBefore}`,
    )
    .order(
      "last_health_check_at",
      {
        ascending: true,
        nullsFirst: true,
      },
    )
    .limit(limit);

  if (connectionError) {
    console.error(
      "OAuth health candidate lookup failed",
      {
        code: connectionError.code,
        message: connectionError.message,
        details: connectionError.details,
        hint: connectionError.hint,
      },
    );

    return {
      ok: false,
      message:
        "OAuth health candidates could not be loaded.",
    };
  }

  const rows =
    (connectionData ??
      []) as OAuthHealthCandidateRow[];

  return {
    ok: true,
    consultantIds:
      rows.map(
        (row) =>
          row.consultant_id,
      ),
  };
};

export const processOAuthHealthCheck = async (
  consultantId: string,
): Promise<ProcessOAuthHealthCheckResult> => {
  const {
    data: consultantData,
    error: consultantError,
  } = await supabaseAdmin
    .from("consultants")
    .select("id, is_active")
    .eq("id", consultantId)
    .maybeSingle();

  if (consultantError) {
    console.error(
      "OAuth health consultant lookup failed",
      {
        consultantId,
        code: consultantError.code,
        message: consultantError.message,
        details: consultantError.details,
        hint: consultantError.hint,
      },
    );

    return {
      ok: false,
      action: "retry",
      message:
        "The consultant could not be loaded.",
    };
  }

  if (!consultantData) {
    return {
      ok: true,
      action: "remove",
      outcome: "missing",
    };
  }

  if (
    consultantData.is_active !==
    true
  ) {
    return {
      ok: true,
      action: "remove",
      outcome: "inactive",
    };
  }

  const {
    data: connectionData,
    error: connectionError,
  } = await supabaseAdmin
    .from("oauth_connections")
    .select("consultant_id")
    .eq("consultant_id", consultantId)
    .eq("provider", "google")
    .maybeSingle();

  if (connectionError) {
    console.error(
      "OAuth health connection lookup failed",
      {
        consultantId,
        code: connectionError.code,
        message: connectionError.message,
        details: connectionError.details,
        hint: connectionError.hint,
      },
    );

    return {
      ok: false,
      action: "retry",
      message:
        "The OAuth connection could not be loaded.",
    };
  }

  if (!connectionData) {
    return {
      ok: true,
      action: "remove",
      outcome: "missing",
    };
  }

  const checkedAt =
    new Date().toISOString();

  const tokenResult =
    await getGoogleAccessToken(
      consultantId,
    );

  if (tokenResult.ok) {
    const updated =
      await updateConnectionHealth({
        consultantId,
        values: {
          health_status:
            "healthy",
          last_health_check_at:
            checkedAt,
          last_health_success_at:
            checkedAt,
          health_failure_code:
            null,
          health_failure_message:
            null,
          consultant_notified_at:
            null,
          admin_notified_at:
            null,
        },
      });

    if (!updated) {
      return {
        ok: false,
        action: "retry",
        message:
          "Healthy OAuth state could not be recorded.",
      };
    }

    return {
      ok: true,
      action: "remove",
      outcome: "healthy",
    };
  }

  const revoked =
    tokenResult.code ===
    "OAUTH_REVOKED";

  const updated =
    await updateConnectionHealth({
      consultantId,
      values: {
        health_status:
          revoked
            ? "revoked"
            : "error",
        last_health_check_at:
          checkedAt,
        health_failure_code:
          tokenResult.code,
        health_failure_message:
          revoked
            ? "Google Calendar connection is revoked. Reconnection is required."
            : "Google Calendar connection could not be verified.",
      },
    });

  if (!updated) {
    return {
      ok: false,
      action: "retry",
      message:
        "Failed OAuth health state could not be recorded.",
    };
  }

  return {
    ok: true,
    action: "remove",
    outcome:
      revoked
        ? "revoked"
        : "error",
  };
};
