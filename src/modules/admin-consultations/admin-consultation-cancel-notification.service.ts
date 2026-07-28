import { env } from "../../config/env.js";
import { sendTransactionalEmail } from "../../lib/mandrill.js";
import { redis } from "../../lib/redis.js";
import { supabaseAdmin } from "../../lib/supabase.js";

const DELIVERY_PREFIX =
  "admin-consultation-cancel-notification:delivery:";

const DELIVERY_TTL_SECONDS =
  30 * 24 * 60 * 60;

type ConsultationRow = {
  id: string;
  consultant_id: string;
  scheduled_start_at: string;
  status: string;
};

type IntakeRow = {
  full_name: string;
  email: string;
};

type ConsultantRow = {
  profile_id: string;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
};

type NotificationContext = {
  consultation: ConsultationRow;
  intake: IntakeRow;
  consultant: ProfileRow | null;
};

export type AdminCancellationNotificationResult = {
  client:
    | "sent"
    | "already_sent"
    | "skipped"
    | "failed";
  consultant:
    | "sent"
    | "already_sent"
    | "skipped"
    | "failed";
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
  value: string | null | undefined,
): value is string => {
  if (!value) return false;

  const normalized =
    normalizeEmail(value);

  return (
    normalized.length > 3 &&
    normalized.includes("@")
  );
};

const deliveryKey = (
  consultationId: string,
): string =>
  `${DELIVERY_PREFIX}${consultationId}`;

const deliveryWasRecorded =
  async (
    consultationId: string,
    recipientKey: string,
  ): Promise<boolean> => {
    try {
      return (
        await redis.hget(
          deliveryKey(consultationId),
          recipientKey,
        )
      ) === "sent";
    } catch (error) {
      console.error(
        "Admin cancellation notification delivery lookup failed",
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
        deliveryKey(consultationId);

      await redis
        .multi()
        .hset(
          key,
          recipientKey,
          "sent",
        )
        .expire(
          key,
          DELIVERY_TTL_SECONDS,
        )
        .exec();

      return true;
    } catch (error) {
      console.error(
        "Admin cancellation notification delivery write failed",
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

const loadContext = async (
  consultationId: string,
): Promise<NotificationContext | null> => {
  const {
    data: consultationData,
    error: consultationError,
  } = await supabaseAdmin
    .from("consultations")
    .select(
      "id, consultant_id, scheduled_start_at, status",
    )
    .eq("id", consultationId)
    .maybeSingle();

  if (
    consultationError ||
    !consultationData
  ) {
    console.error(
      "Admin cancellation notification consultation lookup failed",
      {
        consultationId,
        code:
          consultationError?.code,
        message:
          consultationError?.message,
      },
    );

    return null;
  }

  const consultation =
    consultationData as unknown as ConsultationRow;

  if (
    consultation.status !== "cancelled" &&
    consultation.status !== "refunded"
  ) {
    console.warn(
      "Admin cancellation notification suppressed for non-final status",
      {
        consultationId,
        status:
          consultation.status,
      },
    );

    return null;
  }

  const {
    data: intakeData,
    error: intakeError,
  } = await supabaseAdmin
    .from("consultation_intake")
    .select("full_name, email")
    .eq(
      "consultation_id",
      consultationId,
    )
    .maybeSingle();

  if (
    intakeError ||
    !intakeData
  ) {
    console.error(
      "Admin cancellation notification intake lookup failed",
      {
        consultationId,
        code:
          intakeError?.code,
        message:
          intakeError?.message,
      },
    );

    return null;
  }

  const {
    data: consultantData,
    error: consultantError,
  } = await supabaseAdmin
    .from("consultants")
    .select("profile_id")
    .eq(
      "id",
      consultation.consultant_id,
    )
    .maybeSingle();

  if (consultantError) {
    console.error(
      "Admin cancellation notification consultant lookup failed",
      {
        consultationId,
        consultantId:
          consultation.consultant_id,
        code:
          consultantError.code,
        message:
          consultantError.message,
      },
    );
  }

  let consultant:
    ProfileRow | null = null;

  const profileId =
    (
      consultantData as unknown as
        | ConsultantRow
        | null
    )?.profile_id;

  if (profileId) {
    const {
      data: profileData,
      error: profileError,
    } = await supabaseAdmin
      .from("profiles")
      .select(
        "id, full_name, email",
      )
      .eq("id", profileId)
      .maybeSingle();

    if (profileError) {
      console.error(
        "Admin cancellation notification consultant profile lookup failed",
        {
          consultationId,
          profileId,
          code:
            profileError.code,
          message:
            profileError.message,
        },
      );
    } else if (profileData) {
      consultant =
        profileData as unknown as ProfileRow;
    }
  }

  return {
    consultation,
    intake:
      intakeData as unknown as IntakeRow,
    consultant,
  };
};

const sendClientNotification = async ({
  context,
  refunded,
}: {
  context: NotificationContext;
  refunded: boolean;
}): Promise<
  "sent" | "already_sent" | "skipped" | "failed"
> => {
  const recipientKey =
    `client:${normalizeEmail(context.intake.email)}`;

  if (
    await deliveryWasRecorded(
      context.consultation.id,
      recipientKey,
    )
  ) {
    return "already_sent";
  }

  if (
    !isUsableEmail(
      context.intake.email,
    )
  ) {
    return "skipped";
  }

  const clientName =
    context.intake.full_name.trim() ||
    "there";

  const scheduledTime =
    formatScheduledTime(
      context.consultation.scheduled_start_at,
    );

  const loginUrl =
    `${env.APP_URL.replace(/\/+$/, "")}/login`;

  const paymentHtml =
    refunded
      ? "<p>The captured payment has been refunded. Your bank may take several business days to display the funds.</p>"
      : "<p>No refund was issued as part of this cancellation.</p>";

  const paymentText =
    refunded
      ? "The captured payment has been refunded. Your bank may take several business days to display the funds."
      : "No refund was issued as part of this cancellation.";

  const result =
    await sendTransactionalEmail({
      to: {
        email:
          normalizeEmail(
            context.intake.email,
          ),
        name:
          clientName,
      },
      subject:
        refunded
          ? "Your MakeHijrah consultation was cancelled and refunded"
          : "Your MakeHijrah consultation was cancelled",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
          <h1 style="font-family:Georgia,serif;color:#364355;">Consultation cancelled</h1>
          <p>As-salāmu ʿalaykum ${escapeHtml(clientName)},</p>
          <p>Your MakeHijrah consultation scheduled for <strong>${escapeHtml(scheduledTime)}</strong> has been cancelled.</p>
          ${paymentHtml}
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
        `Your MakeHijrah consultation scheduled for ${scheduledTime} has been cancelled.`,
        "",
        paymentText,
        "",
        `Sign in: ${loginUrl}`,
        "",
        "MakeHijrah Consultations",
      ].join("\n"),
      tags: [
        refunded
          ? "consultation-refunded-client"
          : "consultation-cancelled-client",
      ],
    });

  if (!result.ok) {
    console.error(
      "Client admin cancellation notification failed",
      {
        consultationId:
          context.consultation.id,
        message:
          result.message,
      },
    );

    return "failed";
  }

  return (
    await recordDelivery(
      context.consultation.id,
      recipientKey,
    )
  )
    ? "sent"
    : "failed";
};

const sendConsultantNotification = async ({
  context,
  refunded,
}: {
  context: NotificationContext;
  refunded: boolean;
}): Promise<
  "sent" | "already_sent" | "skipped" | "failed"
> => {
  const consultant =
    context.consultant;

  if (
    !consultant ||
    !isUsableEmail(
      consultant.email,
    )
  ) {
    return "skipped";
  }

  const recipientKey =
    `consultant:${consultant.id}`;

  if (
    await deliveryWasRecorded(
      context.consultation.id,
      recipientKey,
    )
  ) {
    return "already_sent";
  }

  const consultantName =
    consultant.full_name?.trim() ||
    "Consultant";

  const scheduledTime =
    formatScheduledTime(
      context.consultation.scheduled_start_at,
    );

  const consultantUrl =
    `${env.APP_URL.replace(/\/+$/, "")}/consultant`;

  const result =
    await sendTransactionalEmail({
      to: {
        email:
          normalizeEmail(
            consultant.email,
          ),
        name:
          consultantName,
      },
      subject:
        "MakeHijrah consultation cancelled by administration",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
          <h1 style="font-family:Georgia,serif;color:#364355;">Consultation cancelled</h1>
          <p>As-salāmu ʿalaykum ${escapeHtml(consultantName)},</p>
          <p>The MakeHijrah administration cancelled the consultation scheduled for <strong>${escapeHtml(scheduledTime)}</strong>.</p>
          <p>${refunded ? "The client payment was refunded." : "No refund was issued as part of this action."}</p>
          <p>
            <a href="${escapeHtml(consultantUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
              Open consultant dashboard
            </a>
          </p>
          <p>MakeHijrah Consultations</p>
        </div>
      `,
      text: [
        `As-salāmu ʿalaykum ${consultantName},`,
        "",
        `The MakeHijrah administration cancelled the consultation scheduled for ${scheduledTime}.`,
        "",
        refunded
          ? "The client payment was refunded."
          : "No refund was issued as part of this action.",
        "",
        `Consultant dashboard: ${consultantUrl}`,
        "",
        "MakeHijrah Consultations",
      ].join("\n"),
      tags: [
        refunded
          ? "consultation-refunded-consultant"
          : "consultation-cancelled-consultant",
      ],
    });

  if (!result.ok) {
    console.error(
      "Consultant admin cancellation notification failed",
      {
        consultationId:
          context.consultation.id,
        consultantProfileId:
          consultant.id,
        message:
          result.message,
      },
    );

    return "failed";
  }

  return (
    await recordDelivery(
      context.consultation.id,
      recipientKey,
    )
  )
    ? "sent"
    : "failed";
};

export const sendAdminCancellationNotifications =
  async ({
    consultationId,
    refunded,
  }: {
    consultationId: string;
    refunded: boolean;
  }): Promise<AdminCancellationNotificationResult> => {
    const context =
      await loadContext(
        consultationId,
      );

    if (!context) {
      return {
        client: "failed",
        consultant: "failed",
      };
    }

    const [
      client,
      consultant,
    ] = await Promise.all([
      sendClientNotification({
        context,
        refunded,
      }),
      sendConsultantNotification({
        context,
        refunded,
      }),
    ]);

    return {
      client,
      consultant,
    };
  };
