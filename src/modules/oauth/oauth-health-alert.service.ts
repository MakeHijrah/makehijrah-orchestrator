import { env } from "../../config/env.js";
import { sendTransactionalEmail } from "../../lib/mandrill.js";
import { redis } from "../../lib/redis.js";
import { supabaseAdmin } from "../../lib/supabase.js";

const REMINDER_INTERVAL_MS =
  24 * 60 * 60 * 1000;

const DELIVERY_TTL_SECONDS =
  24 * 60 * 60;

const DELIVERY_PREFIX =
  "oauth-health-alert:delivery:";

type HealthConnectionRow = {
  consultant_id: string;
  health_status: "revoked" | "error";
  health_failure_code: string | null;
  health_failure_message: string | null;
  consultant_notified_at: string | null;
  admin_notified_at: string | null;
};

type ConsultantRow = {
  id: string;
  profile_id: string;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
};

type AlertContext = {
  connection: HealthConnectionRow;
  consultant: ConsultantRow;
  consultantProfile: ProfileRow;
  admins: ProfileRow[];
};

export type ListOAuthHealthAlertCandidatesResult =
  | {
      ok: true;
      consultantIds: string[];
    }
  | {
      ok: false;
      message: string;
    };

export type ProcessOAuthHealthAlertResult =
  | {
      ok: true;
      action: "remove";
      outcome:
        | "sent"
        | "not_due"
        | "healthy"
        | "missing";
    }
  | {
      ok: false;
      action: "retry";
      message: string;
    };

const normalizeEmail = (
  value: string,
): string =>
  value.trim().toLowerCase();

const isUsableEmail = (
  value: string,
): boolean => {
  const normalized =
    normalizeEmail(value);

  return (
    normalized.length > 3 &&
    normalized.includes("@")
  );
};

const escapeHtml = (
  value: string,
): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const wasSentWithinReminderWindow = (
  value: string | null,
): boolean => {
  if (!value) {
    return false;
  }

  const timestamp =
    new Date(value).getTime();

  return (
    Number.isFinite(timestamp) &&
    timestamp >
      Date.now() -
        REMINDER_INTERVAL_MS
  );
};

const deliveryKey = ({
  consultantId,
  recipientKey,
}: {
  consultantId: string;
  recipientKey: string;
}): string =>
  [
    DELIVERY_PREFIX,
    consultantId,
    recipientKey,
  ].join(":");

const deliveryWasRecorded = async ({
  consultantId,
  recipientKey,
}: {
  consultantId: string;
  recipientKey: string;
}): Promise<boolean> => {
  try {
    return (
      await redis.exists(
        deliveryKey({
          consultantId,
          recipientKey,
        }),
      )
    ) === 1;
  } catch (error) {
    console.error(
      "OAuth health alert delivery lookup failed",
      {
        consultantId,
        recipientKey,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );

    return false;
  }
};

const recordDelivery = async ({
  consultantId,
  recipientKey,
}: {
  consultantId: string;
  recipientKey: string;
}): Promise<boolean> => {
  try {
    await redis.set(
      deliveryKey({
        consultantId,
        recipientKey,
      }),
      new Date().toISOString(),
      "EX",
      DELIVERY_TTL_SECONDS,
    );

    return true;
  } catch (error) {
    console.error(
      "OAuth health alert delivery write failed",
      {
        consultantId,
        recipientKey,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );

    return false;
  }
};

const loadAlertContext = async (
  consultantId: string,
): Promise<
  | {
      ok: true;
      context: AlertContext;
    }
  | {
      ok: false;
      kind: "temporary" | "permanent";
      message: string;
    }
> => {
  const {
    data: connectionData,
    error: connectionError,
  } = await supabaseAdmin
    .from("oauth_connections")
    .select(
      [
        "consultant_id",
        "health_status",
        "health_failure_code",
        "health_failure_message",
        "consultant_notified_at",
        "admin_notified_at",
      ].join(", "),
    )
    .eq("consultant_id", consultantId)
    .eq("provider", "google")
    .maybeSingle();

  if (connectionError) {
    console.error(
      "OAuth health alert connection lookup failed",
      {
        consultantId,
        code: connectionError.code,
        message: connectionError.message,
      },
    );

    return {
      ok: false,
      kind: "temporary",
      message:
        "The OAuth connection could not be loaded.",
    };
  }

  if (!connectionData) {
    return {
      ok: false,
      kind: "permanent",
      message:
        "The OAuth connection was not found.",
    };
  }

  const connection =
    connectionData as unknown as HealthConnectionRow;

  if (
    connection.health_status !==
      "revoked" &&
    connection.health_status !==
      "error"
  ) {
    return {
      ok: false,
      kind: "permanent",
      message:
        "The OAuth connection is not degraded.",
    };
  }

  const {
    data: consultantData,
    error: consultantError,
  } = await supabaseAdmin
    .from("consultants")
    .select("id, profile_id")
    .eq("id", consultantId)
    .eq("is_active", true)
    .maybeSingle();

  if (consultantError) {
    console.error(
      "OAuth health alert consultant lookup failed",
      {
        consultantId,
        code: consultantError.code,
        message: consultantError.message,
      },
    );

    return {
      ok: false,
      kind: "temporary",
      message:
        "The consultant could not be loaded.",
    };
  }

  if (!consultantData) {
    return {
      ok: false,
      kind: "permanent",
      message:
        "The active consultant was not found.",
    };
  }

  const consultant =
    consultantData as unknown as ConsultantRow;

  const {
    data: consultantProfileData,
    error: consultantProfileError,
  } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, email")
    .eq("id", consultant.profile_id)
    .maybeSingle();

  if (
    consultantProfileError ||
    !consultantProfileData
  ) {
    console.error(
      "OAuth health alert consultant profile lookup failed",
      {
        consultantId,
        code:
          consultantProfileError?.code,
        message:
          consultantProfileError?.message,
      },
    );

    return {
      ok: false,
      kind: "temporary",
      message:
        "The consultant profile could not be loaded.",
    };
  }

  const consultantProfile =
    consultantProfileData as unknown as ProfileRow;

  if (
    !isUsableEmail(
      consultantProfile.email,
    )
  ) {
    return {
      ok: false,
      kind: "permanent",
      message:
        "The consultant email is invalid.",
    };
  }

  const {
    data: adminData,
    error: adminError,
  } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, email")
    .eq("role", "admin");

  if (adminError) {
    console.error(
      "OAuth health alert admin lookup failed",
      {
        consultantId,
        code: adminError.code,
        message: adminError.message,
      },
    );

    return {
      ok: false,
      kind: "temporary",
      message:
        "Admin recipients could not be loaded.",
    };
  }

  const admins =
    (
      (adminData ?? []) as ProfileRow[]
    ).filter(
      (admin) =>
        isUsableEmail(
          admin.email,
        ),
    );

  if (admins.length === 0) {
    return {
      ok: false,
      kind: "temporary",
      message:
        "No valid admin recipient is configured.",
    };
  }

  return {
    ok: true,
    context: {
      connection,
      consultant,
      consultantProfile,
      admins,
    },
  };
};

const sendConsultantAlert = async (
  context: AlertContext,
): Promise<boolean> => {
  const consultantId =
    context.consultant.id;

  const recipientKey =
    `consultant:${context.consultantProfile.id}`;

  if (
    await deliveryWasRecorded({
      consultantId,
      recipientKey,
    })
  ) {
    return true;
  }

  const name =
    context.consultantProfile
      .full_name?.trim() ||
    "Consultant";

  const reconnectUrl =
    `${env.APP_URL.replace(
      /\/+$/,
      "",
    )}/consultant/profile`;

  const result =
    await sendTransactionalEmail({
      to: {
        email:
          normalizeEmail(
            context.consultantProfile.email,
          ),
        name,
      },
      subject:
        "Reconnect Google Calendar to MakeHijrah",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
          <h1 style="font-family:Georgia,serif;color:#364355;">Google Calendar requires attention</h1>
          <p>As-salāmu ʿalaykum ${escapeHtml(name)},</p>
          <p>MakeHijrah could not verify your Google Calendar connection.</p>
          <p>Your public availability remains active in degraded mode, but you cannot accept a consultation until Google Calendar is reconnected.</p>
          <p>
            <a href="${escapeHtml(reconnectUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
              Reconnect Google Calendar
            </a>
          </p>
          <p>MakeHijrah Consultations</p>
        </div>
      `,
      text: [
        `As-salāmu ʿalaykum ${name},`,
        "",
        "MakeHijrah could not verify your Google Calendar connection.",
        "",
        "Your public availability remains active in degraded mode, but you cannot accept a consultation until Google Calendar is reconnected.",
        "",
        `Reconnect Google Calendar: ${reconnectUrl}`,
        "",
        "MakeHijrah Consultations",
      ].join("\n"),
      tags: [
        "oauth-health-consultant",
      ],
    });

  if (!result.ok) {
    console.error(
      "OAuth health consultant alert failed",
      {
        consultantId,
        message: result.message,
      },
    );

    return false;
  }

  return recordDelivery({
    consultantId,
    recipientKey,
  });
};

const sendAdminAlert = async ({
  context,
  admin,
}: {
  context: AlertContext;
  admin: ProfileRow;
}): Promise<boolean> => {
  const consultantId =
    context.consultant.id;

  const recipientKey =
    `admin:${admin.id}`;

  if (
    await deliveryWasRecorded({
      consultantId,
      recipientKey,
    })
  ) {
    return true;
  }

  const name =
    admin.full_name?.trim() ||
    "Administrator";

  const adminUrl =
    `${env.APP_URL.replace(
      /\/+$/,
      "",
    )}/admin/consultants`;

  const failureCode =
    context.connection
      .health_failure_code ||
    context.connection.health_status;

  const result =
    await sendTransactionalEmail({
      to: {
        email:
          normalizeEmail(
            admin.email,
          ),
        name,
      },
      subject:
        "Consultant Google Calendar connection requires attention",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
          <h1 style="font-family:Georgia,serif;color:#364355;">Calendar connection requires attention</h1>
          <p>As-salāmu ʿalaykum ${escapeHtml(name)},</p>
          <p>An active consultant's Google Calendar connection could not be verified.</p>
          <div style="border:1px solid #d9e2de;padding:20px;margin:24px 0;">
            <p><strong>Consultant:</strong><br>${escapeHtml(context.consultantProfile.full_name || context.consultantProfile.email)}</p>
            <p><strong>Consultant ID:</strong><br>${escapeHtml(consultantId)}</p>
            <p><strong>Connection state:</strong><br>${escapeHtml(context.connection.health_status)}</p>
            <p><strong>Failure code:</strong><br>${escapeHtml(failureCode)}</p>
          </div>
          <p>The consultant remains bookable in degraded mode but cannot accept a consultation until reconnection succeeds.</p>
          <p>
            <a href="${escapeHtml(adminUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
              Review consultants
            </a>
          </p>
          <p>MakeHijrah Consultations</p>
        </div>
      `,
      text: [
        `As-salāmu ʿalaykum ${name},`,
        "",
        "An active consultant's Google Calendar connection could not be verified.",
        "",
        `Consultant: ${context.consultantProfile.full_name || context.consultantProfile.email}`,
        `Consultant ID: ${consultantId}`,
        `Connection state: ${context.connection.health_status}`,
        `Failure code: ${failureCode}`,
        "",
        "The consultant remains bookable in degraded mode but cannot accept a consultation until reconnection succeeds.",
        "",
        `Review consultants: ${adminUrl}`,
        "",
        "MakeHijrah Consultations",
      ].join("\n"),
      tags: [
        "oauth-health-admin",
      ],
    });

  if (!result.ok) {
    console.error(
      "OAuth health admin alert failed",
      {
        consultantId,
        adminProfileId: admin.id,
        message: result.message,
      },
    );

    return false;
  }

  return recordDelivery({
    consultantId,
    recipientKey,
  });
};

const updateNotificationTimestamps = async ({
  consultantId,
  consultantSentAt,
  adminSentAt,
}: {
  consultantId: string;
  consultantSentAt?: string;
  adminSentAt?: string;
}): Promise<boolean> => {
  const values: Record<string, string> =
    {
      updated_at:
        new Date().toISOString(),
    };

  if (consultantSentAt) {
    values.consultant_notified_at =
      consultantSentAt;
  }

  if (adminSentAt) {
    values.admin_notified_at =
      adminSentAt;
  }

  const { error } = await supabaseAdmin
    .from("oauth_connections")
    .update(values)
    .eq("consultant_id", consultantId)
    .eq("provider", "google");

  if (error) {
    console.error(
      "OAuth health notification timestamp update failed",
      {
        consultantId,
        code: error.code,
        message: error.message,
      },
    );

    return false;
  }

  return true;
};

export const listOAuthHealthAlertCandidates = async (
  limit = 25,
): Promise<ListOAuthHealthAlertCandidatesResult> => {
  const dueBefore =
    new Date(
      Date.now() -
        REMINDER_INTERVAL_MS,
    ).toISOString();

  const {
    data: consultantData,
    error: consultantError,
  } = await supabaseAdmin
    .from("consultants")
    .select("id")
    .eq("is_active", true);

  if (consultantError) {
    console.error(
      "OAuth health alert active-consultant lookup failed",
      {
        code: consultantError.code,
        message: consultantError.message,
      },
    );

    return {
      ok: false,
      message:
        "Active consultants could not be loaded.",
    };
  }

  const activeConsultantIds =
    (consultantData ?? [])
      .map((row) => row.id as string)
      .filter(Boolean);

  if (activeConsultantIds.length === 0) {
    return {
      ok: true,
      consultantIds: [],
    };
  }

  const {
    data,
    error,
  } = await supabaseAdmin
    .from("oauth_connections")
    .select("consultant_id")
    .eq("provider", "google")
    .in(
      "consultant_id",
      activeConsultantIds,
    )
    .in(
      "health_status",
      ["revoked", "error"],
    )
    .or(
      [
        "consultant_notified_at.is.null",
        `consultant_notified_at.lt.${dueBefore}`,
        "admin_notified_at.is.null",
        `admin_notified_at.lt.${dueBefore}`,
      ].join(","),
    )
    .limit(limit);

  if (error) {
    console.error(
      "OAuth health alert candidate lookup failed",
      {
        code: error.code,
        message: error.message,
      },
    );

    return {
      ok: false,
      message:
        "OAuth health alert candidates could not be loaded.",
    };
  }

  return {
    ok: true,
    consultantIds:
      (data ?? []).map(
        (row) =>
          row.consultant_id as string,
      ),
  };
};

export const processOAuthHealthAlert = async (
  consultantId: string,
): Promise<ProcessOAuthHealthAlertResult> => {
  const contextResult =
    await loadAlertContext(
      consultantId,
    );

  if (!contextResult.ok) {
    if (
      contextResult.kind ===
      "permanent"
    ) {
      return {
        ok: true,
        action: "remove",
        outcome:
          contextResult.message.includes(
            "not degraded",
          )
            ? "healthy"
            : "missing",
      };
    }

    return {
      ok: false,
      action: "retry",
      message:
        contextResult.message,
    };
  }

  const context =
    contextResult.context;

  const consultantDue =
    !wasSentWithinReminderWindow(
      context.connection
        .consultant_notified_at,
    );

  const adminDue =
    !wasSentWithinReminderWindow(
      context.connection
        .admin_notified_at,
    );

  if (
    !consultantDue &&
    !adminDue
  ) {
    return {
      ok: true,
      action: "remove",
      outcome: "not_due",
    };
  }

  const sentAt =
    new Date().toISOString();

  if (consultantDue) {
    const sent =
      await sendConsultantAlert(
        context,
      );

    if (!sent) {
      return {
        ok: false,
        action: "retry",
        message:
          "The consultant OAuth health alert could not be delivered.",
      };
    }

    const timestampSaved =
      await updateNotificationTimestamps({
        consultantId,
        consultantSentAt:
          sentAt,
      });

    if (!timestampSaved) {
      return {
        ok: false,
        action: "retry",
        message:
          "The consultant alert timestamp could not be recorded.",
      };
    }
  }

  if (adminDue) {
    for (
      const admin of
      context.admins
    ) {
      const sent =
        await sendAdminAlert({
          context,
          admin,
        });

      if (!sent) {
        return {
          ok: false,
          action: "retry",
          message:
            "An admin OAuth health alert could not be delivered.",
        };
      }
    }

    const timestampSaved =
      await updateNotificationTimestamps({
        consultantId,
        adminSentAt:
          sentAt,
      });

    if (!timestampSaved) {
      return {
        ok: false,
        action: "retry",
        message:
          "The admin alert timestamp could not be recorded.",
      };
    }
  }

  return {
    ok: true,
    action: "remove",
    outcome: "sent",
  };
};
