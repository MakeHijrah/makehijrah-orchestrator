import { env } from "../../config/env.js";
import {
  sendTransactionalEmail,
} from "../../lib/mandrill.js";
import { redis } from "../../lib/redis.js";
import { supabaseAdmin } from "../../lib/supabase.js";

export const DECLINE_NOTIFICATION_DUE_SET =
  "decline-notification:due";

export const DECLINE_NOTIFICATION_LOCK_PREFIX =
  "decline-notification:lock:";

const DECLINE_NOTIFICATION_PAYLOAD_PREFIX =
  "decline-notification:payload:";

const DECLINE_NOTIFICATION_DELIVERY_PREFIX =
  "decline-notification:delivery:";

const DECLINE_NOTIFICATION_DONE_PREFIX =
  "decline-notification:done:";

const PAYLOAD_TTL_SECONDS =
  7 * 24 * 60 * 60;

const DONE_TTL_SECONDS =
  30 * 24 * 60 * 60;

type DeclineNotificationPayload = {
  consultationId: string;
  declineReason: string | null;
  queuedAt: string;
};

type ConsultationRow = {
  id: string;
  client_profile_id: string;
  consultant_id: string;
  scheduled_start_at: string;
  declined_at: string | null;
  admin_attention_reason: string | null;
};

type IntakeRow = {
  full_name: string;
  email: string;
};

type AdminProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
};

type NotificationContext = {
  consultation: ConsultationRow;
  intake: IntakeRow;
  admins: AdminProfileRow[];
};

export type ScheduleDeclineNotificationResult =
  | {
      ok: true;
      consultationId: string;
      notification:
        | "scheduled"
        | "already_scheduled"
        | "already_sent";
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

export type ProcessDeclineNotificationResult =
  | {
      ok: true;
      action: "remove";
      outcome:
        | "sent"
        | "already_sent"
        | "permanent_failure";
    }
  | {
      ok: false;
      action: "retry";
      message: string;
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

const payloadKey = (
  consultationId: string,
): string =>
  `${DECLINE_NOTIFICATION_PAYLOAD_PREFIX}${consultationId}`;

const deliveryKey = (
  consultationId: string,
): string =>
  `${DECLINE_NOTIFICATION_DELIVERY_PREFIX}${consultationId}`;

const doneKey = (
  consultationId: string,
): string =>
  `${DECLINE_NOTIFICATION_DONE_PREFIX}${consultationId}`;

const formatScheduledTime = (
  value: string,
): string => {
  const parsed =
    new Date(value);

  if (
    Number.isNaN(
      parsed.getTime(),
    )
  ) {
    return value;
  }

  return `${new Intl.DateTimeFormat(
    "en-GB",
    {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    },
  ).format(parsed)} UTC`;
};

const loadPayload = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      payload:
        | DeclineNotificationPayload
        | null;
    }
  | {
      ok: false;
      message: string;
    }
> => {
  try {
    const raw =
      await redis.get(
        payloadKey(
          consultationId,
        ),
      );

    if (!raw) {
      return {
        ok: true,
        payload: null,
      };
    }

    const parsed =
      JSON.parse(
        raw,
      ) as Partial<DeclineNotificationPayload>;

    if (
      parsed.consultationId !==
        consultationId ||
      typeof parsed.queuedAt !==
        "string" ||
      !(
        parsed.declineReason ===
          null ||
        typeof parsed.declineReason ===
          "string"
      )
    ) {
      console.error(
        "Decline notification payload is invalid",
        {
          consultationId,
        },
      );

      return {
        ok: true,
        payload: null,
      };
    }

    return {
      ok: true,
      payload: {
        consultationId:
          parsed.consultationId,
        declineReason:
          parsed.declineReason,
        queuedAt:
          parsed.queuedAt,
      },
    };
  } catch (error) {
    console.error(
      "Decline notification payload lookup failed",
      {
        consultationId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );

    return {
      ok: false,
      message:
        "The decline notification payload could not be loaded.",
    };
  }
};

const loadNotificationContext =
  async (
    consultationId: string,
  ): Promise<
    | {
        ok: true;
        context: NotificationContext;
      }
    | {
        ok: false;
        kind:
          | "temporary"
          | "permanent";
        message: string;
      }
  > => {
    const {
      data: consultationData,
      error: consultationError,
    } = await supabaseAdmin
      .from("consultations")
      .select(
        [
          "id",
          "client_profile_id",
          "consultant_id",
          "scheduled_start_at",
          "declined_at",
          "admin_attention_reason",
        ].join(", "),
      )
      .eq(
        "id",
        consultationId,
      )
      .maybeSingle();

    if (consultationError) {
      console.error(
        "Decline notification consultation lookup failed",
        {
          consultationId,
          code:
            consultationError.code,
          message:
            consultationError.message,
          details:
            consultationError.details,
          hint:
            consultationError.hint,
        },
      );

      return {
        ok: false,
        kind: "temporary",
        message:
          "The declined consultation could not be loaded.",
      };
    }

    if (!consultationData) {
      console.warn(
        "Decline notification suppressed because the consultation is missing",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultation was not found.",
      };
    }

    const consultation =
      consultationData as unknown as ConsultationRow;

    if (
      !consultation.declined_at ||
      consultation
        .admin_attention_reason !==
        "declined"
    ) {
      console.warn(
        "Decline notification suppressed because the consultation is not finalized as declined",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultation is not finalized as declined.",
      };
    }

    const {
      data: intakeData,
      error: intakeError,
    } = await supabaseAdmin
      .from(
        "consultation_intake",
      )
      .select(
        "full_name, email",
      )
      .eq(
        "consultation_id",
        consultationId,
      )
      .maybeSingle();

    if (intakeError) {
      console.error(
        "Decline notification intake lookup failed",
        {
          consultationId,
          code:
            intakeError.code,
          message:
            intakeError.message,
          details:
            intakeError.details,
          hint:
            intakeError.hint,
        },
      );

      return {
        ok: false,
        kind: "temporary",
        message:
          "The consultation intake could not be loaded.",
      };
    }

    if (!intakeData) {
      console.warn(
        "Decline notification suppressed because consultation intake is missing",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultation intake was not found.",
      };
    }

    const intake =
      intakeData as IntakeRow;

    if (
      !isUsableEmail(
        intake.email,
      )
    ) {
      console.warn(
        "Decline notification suppressed because the client email is invalid",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The client email is invalid.",
      };
    }

    const {
      data: adminData,
      error: adminError,
    } = await supabaseAdmin
      .from("profiles")
      .select(
        "id, full_name, email",
      )
      .eq(
        "role",
        "admin",
      );

    if (adminError) {
      console.error(
        "Decline notification admin lookup failed",
        {
          consultationId,
          code:
            adminError.code,
          message:
            adminError.message,
          details:
            adminError.details,
          hint:
            adminError.hint,
        },
      );

      return {
        ok: false,
        kind: "temporary",
        message:
          "The admin recipients could not be loaded.",
      };
    }

    const admins =
      (
        (adminData ?? []) as AdminProfileRow[]
      ).filter(
        (admin) =>
          isUsableEmail(
            admin.email,
          ),
      );

    if (
      admins.length === 0
    ) {
      console.error(
        "Decline notification has no valid admin recipients",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        kind: "temporary",
        message:
          "No valid admin notification recipient is configured.",
      };
    }

    return {
      ok: true,
      context: {
        consultation,
        intake,
        admins,
      },
    };
  };

const deliveryWasRecorded =
  async (
    consultationId: string,
    recipientKey: string,
  ): Promise<boolean> => {
    try {
      const value =
        await redis.hget(
          deliveryKey(
            consultationId,
          ),
          recipientKey,
        );

      return value === "sent";
    } catch (error) {
      console.error(
        "Decline notification delivery marker lookup failed",
        {
          consultationId,
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

const recordDelivery =
  async (
    consultationId: string,
    recipientKey: string,
  ): Promise<boolean> => {
    try {
      const key =
        deliveryKey(
          consultationId,
        );

      await redis
        .multi()
        .hset(
          key,
          recipientKey,
          "sent",
        )
        .expire(
          key,
          PAYLOAD_TTL_SECONDS,
        )
        .exec();

      return true;
    } catch (error) {
      console.error(
        "Decline notification delivery marker write failed",
        {
          consultationId,
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

const sendClientNotification =
  async ({
    consultationId,
    context,
  }: {
    consultationId: string;
    context: NotificationContext;
  }): Promise<boolean> => {
    const recipientKey =
      `client:${context.consultation.client_profile_id}`;

    if (
      await deliveryWasRecorded(
        consultationId,
        recipientKey,
      )
    ) {
      return true;
    }

    const clientName =
      context.intake.full_name
        .trim() ||
      "there";

    const loginUrl =
      `${env.APP_URL.replace(
        /\/+$/,
        "",
      )}/login`;

    const scheduledTime =
      formatScheduledTime(
        context.consultation
          .scheduled_start_at,
      );

    const result =
      await sendTransactionalEmail({
        to: {
          email:
            normalizeEmail(
              context.intake.email,
            ),
          name: clientName,
        },
        subject:
          "Update about your MakeHijrah consultation",
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
            <h1 style="font-family:Georgia,serif;color:#364355;">Consultation update</h1>
            <p>As-salāmu ʿalaykum ${escapeHtml(clientName)},</p>
            <p>The consultant was unable to accept your consultation scheduled for <strong>${escapeHtml(scheduledTime)}</strong>.</p>
            <p>Your payment authorisation has been cancelled. <strong>No charge was made.</strong></p>
            <p>The MakeHijrah team will follow up regarding available alternatives.</p>
            <p>
              <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
                Sign in to MakeHijrah
              </a>
            </p>
            <p>MakeHijrah Consultations</p>
          </div>
        `,
        text: [
          `As-salāmu ʿalaykum ${clientName},`,
          "",
          `The consultant was unable to accept your consultation scheduled for ${scheduledTime}.`,
          "",
          "Your payment authorisation has been cancelled. No charge was made.",
          "",
          "The MakeHijrah team will follow up regarding available alternatives.",
          "",
          `Sign in: ${loginUrl}`,
          "",
          "MakeHijrah Consultations",
        ].join("\n"),
        tags: [
          "consultation-declined-client",
        ],
      });

    if (!result.ok) {
      console.error(
        "Client decline notification delivery failed",
        {
          consultationId,
          message:
            result.message,
        },
      );

      return false;
    }

    return recordDelivery(
      consultationId,
      recipientKey,
    );
  };

const sendAdminNotification =
  async ({
    consultationId,
    context,
    admin,
    declineReason,
  }: {
    consultationId: string;
    context: NotificationContext;
    admin: AdminProfileRow;
    declineReason: string | null;
  }): Promise<boolean> => {
    const recipientKey =
      `admin:${admin.id}`;

    if (
      await deliveryWasRecorded(
        consultationId,
        recipientKey,
      )
    ) {
      return true;
    }

    const adminName =
      admin.full_name?.trim() ||
      "Administrator";

    const scheduledTime =
      formatScheduledTime(
        context.consultation
          .scheduled_start_at,
      );

    const adminUrl =
      `${env.APP_URL.replace(
        /\/+$/,
        "",
      )}/admin/consultations`;

    const normalizedReason =
      declineReason?.trim() ??
      "";

    const reasonHtml =
      normalizedReason
        ? `
            <p>
              <strong>Consultant-provided reason:</strong><br>
              ${escapeHtml(normalizedReason)}
            </p>
          `
        : "";

    const result =
      await sendTransactionalEmail({
        to: {
          email:
            normalizeEmail(
              admin.email,
            ),
          name:
            adminName,
        },
        subject:
          "Admin attention required: consultation declined",
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
            <h1 style="font-family:Georgia,serif;color:#364355;">Consultation requires attention</h1>
            <p>As-salāmu ʿalaykum ${escapeHtml(adminName)},</p>
            <p>A consultant declined a pending MakeHijrah consultation. The payment authorisation was cancelled and no charge was captured.</p>
            <div style="border:1px solid #d9e2de;padding:20px;margin:24px 0;">
              <p><strong>Consultation ID:</strong><br>${escapeHtml(context.consultation.id)}</p>
              <p><strong>Consultant ID:</strong><br>${escapeHtml(context.consultation.consultant_id)}</p>
              <p><strong>Scheduled time:</strong><br>${escapeHtml(scheduledTime)}</p>
              ${reasonHtml}
            </div>
            <p>
              <a href="${escapeHtml(adminUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
                Review consultations
              </a>
            </p>
            <p>MakeHijrah Consultations</p>
          </div>
        `,
        text: [
          `As-salāmu ʿalaykum ${adminName},`,
          "",
          "A consultant declined a pending MakeHijrah consultation.",
          "The payment authorisation was cancelled and no charge was captured.",
          "",
          `Consultation ID: ${context.consultation.id}`,
          `Consultant ID: ${context.consultation.consultant_id}`,
          `Scheduled time: ${scheduledTime}`,
          normalizedReason
            ? `Consultant-provided reason: ${normalizedReason}`
            : "",
          "",
          `Review consultations: ${adminUrl}`,
          "",
          "MakeHijrah Consultations",
        ]
          .filter(Boolean)
          .join("\n"),
        tags: [
          "consultation-declined-admin",
        ],
      });

    if (!result.ok) {
      console.error(
        "Admin decline notification delivery failed",
        {
          consultationId,
          adminProfileId:
            admin.id,
          message:
            result.message,
        },
      );

      return false;
    }

    return recordDelivery(
      consultationId,
      recipientKey,
    );
  };

const markNotificationDone =
  async (
    consultationId: string,
  ): Promise<boolean> => {
    try {
      await redis
        .multi()
        .set(
          doneKey(
            consultationId,
          ),
          new Date().toISOString(),
          "EX",
          DONE_TTL_SECONDS,
        )
        .del(
          payloadKey(
            consultationId,
          ),
        )
        .del(
          deliveryKey(
            consultationId,
          ),
        )
        .exec();

      return true;
    } catch (error) {
      console.error(
        "Decline notification completion marker failed",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return false;
    }
  };

export const scheduleDeclineNotification =
  async ({
    consultationId,
    declineReason,
  }: {
    consultationId: string;
    declineReason: string | null;
  }): Promise<ScheduleDeclineNotificationResult> => {
    try {
      const alreadyDone =
        await redis.exists(
          doneKey(
            consultationId,
          ),
        );

      if (
        alreadyDone === 1
      ) {
        return {
          ok: true,
          consultationId,
          notification:
            "already_sent",
        };
      }

      const payload: DeclineNotificationPayload =
        {
          consultationId,
          declineReason:
            declineReason?.trim() ||
            null,
          queuedAt:
            new Date().toISOString(),
        };

      const result =
        await redis
          .multi()
          .set(
            payloadKey(
              consultationId,
            ),
            JSON.stringify(
              payload,
            ),
            "EX",
            PAYLOAD_TTL_SECONDS,
            "NX",
          )
          .zadd(
            DECLINE_NOTIFICATION_DUE_SET,
            "NX",
            Date.now(),
            consultationId,
          )
          .exec();

      const payloadWasCreated =
        result?.[0]?.[1] ===
        "OK";

      return {
        ok: true,
        consultationId,
        notification:
          payloadWasCreated
            ? "scheduled"
            : "already_scheduled",
      };
    } catch (error) {
      console.error(
        "Decline notification scheduling failed",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The decline notification could not be scheduled.",
      };
    }
  };

export const processDeclineNotification =
  async (
    consultationId: string,
  ): Promise<ProcessDeclineNotificationResult> => {
    try {
      const alreadyDone =
        await redis.exists(
          doneKey(
            consultationId,
          ),
        );

      if (
        alreadyDone === 1
      ) {
        return {
          ok: true,
          action: "remove",
          outcome:
            "already_sent",
        };
      }
    } catch (error) {
      console.error(
        "Decline notification completion lookup failed",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return {
        ok: false,
        action: "retry",
        message:
          "The decline notification state could not be checked.",
      };
    }

    const payloadResult =
      await loadPayload(
        consultationId,
      );

    if (!payloadResult.ok) {
      return {
        ok: false,
        action: "retry",
        message:
          payloadResult.message,
      };
    }

    if (!payloadResult.payload) {
      return {
        ok: true,
        action: "remove",
        outcome:
          "permanent_failure",
      };
    }

    const contextResult =
      await loadNotificationContext(
        consultationId,
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
            "permanent_failure",
        };
      }

      return {
        ok: false,
        action: "retry",
        message:
          contextResult.message,
      };
    }

    const clientSent =
      await sendClientNotification({
        consultationId,
        context:
          contextResult.context,
      });

    if (!clientSent) {
      return {
        ok: false,
        action: "retry",
        message:
          "The client decline notification could not be delivered.",
      };
    }

    for (
      const admin of
      contextResult.context.admins
    ) {
      const adminSent =
        await sendAdminNotification({
          consultationId,
          context:
            contextResult.context,
          admin,
          declineReason:
            payloadResult.payload
              .declineReason,
        });

      if (!adminSent) {
        return {
          ok: false,
          action: "retry",
          message:
            "An admin decline notification could not be delivered.",
        };
      }
    }

    const completionRecorded =
      await markNotificationDone(
        consultationId,
      );

    if (!completionRecorded) {
      return {
        ok: false,
        action: "retry",
        message:
          "The decline notification completion could not be recorded.",
      };
    }

    return {
      ok: true,
      action: "remove",
      outcome: "sent",
    };
  };