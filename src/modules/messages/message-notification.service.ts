import { env } from "../../config/env.js";
import {
  sendTransactionalEmail,
} from "../../lib/mandrill.js";
import { redis } from "../../lib/redis.js";
import { supabaseAdmin } from "../../lib/supabase.js";

export const MESSAGE_NOTIFICATION_DUE_SET =
  "message-notification:due";

export const MESSAGE_NOTIFICATION_LOCK_PREFIX =
  "message-notification:lock:";

const NOTIFICATION_DELAY_MS = 90_000;

type MessageRow = {
  id: string;
  consultation_id: string;
  sender_profile_id: string;
  recipient_profile_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  email_notification_sent_at: string | null;
};

type ConsultationRow = {
  id: string;
  client_profile_id: string;
  consultant_id: string | null;
  scheduled_start_at: string | null;
};

type ConsultantRow = {
  id: string;
  profile_id: string;
};

type ProfileRow = {
  id: string;
  role: string;
  full_name: string | null;
  email: string | null;
};

type IntakeRow = {
  full_name: string;
  email: string;
};

type ParticipantContext = {
  consultation: ConsultationRow;
  clientProfileId: string;
  consultantProfileId: string;
};

export type ScheduleMessageNotificationResult =
  | {
      ok: true;
      messageId: string;
      notification:
        | "scheduled"
        | "suppressed"
        | "already_sent";
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INTERNAL_ERROR";
      message: string;
    };

export type ProcessMessageNotificationResult =
  | {
      ok: true;
      action: "remove";
      outcome:
        | "sent"
        | "read"
        | "already_sent"
        | "message_missing"
        | "permanent_failure";
    }
  | {
      ok: false;
      action: "retry";
      message: string;
    };

type LoadMessageResult =
  | {
      ok: true;
      message: MessageRow | null;
    }
  | {
      ok: false;
      message: string;
    };

type LoadParticipantContextResult =
  | {
      ok: true;
      context: ParticipantContext;
    }
  | {
      ok: false;
      kind: "invalid" | "temporary";
      message: string;
    };

type LoadProfilesResult =
  | {
      ok: true;
      senderProfile: ProfileRow;
      recipientProfile: ProfileRow;
    }
  | {
      ok: false;
      kind: "invalid" | "temporary";
      message: string;
    };

const loadMessage = async (
  messageId: string,
): Promise<LoadMessageResult> => {
  const { data, error } =
    await supabaseAdmin
      .from("messages")
      .select(
        [
          "id",
          "consultation_id",
          "sender_profile_id",
          "recipient_profile_id",
          "body",
          "created_at",
          "read_at",
          "email_notification_sent_at",
        ].join(", "),
      )
      .eq("id", messageId)
      .maybeSingle();

  if (error) {
    console.error(
      "Message notification lookup failed",
      {
        messageId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      message:
        "The message notification could not be loaded.",
    };
  }

  return {
    ok: true,
    message:
      data as MessageRow | null,
  };
};

const loadParticipantContext = async (
  message: MessageRow,
): Promise<LoadParticipantContextResult> => {
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
      ].join(", "),
    )
    .eq(
      "id",
      message.consultation_id,
    )
    .maybeSingle();

  if (consultationError) {
    console.error(
      "Message consultation lookup failed",
      {
        messageId: message.id,
        consultationId:
          message.consultation_id,
        code: consultationError.code,
        message:
          consultationError.message,
        details:
          consultationError.details,
        hint: consultationError.hint,
      },
    );

    return {
      ok: false,
      kind: "temporary",
      message:
        "The consultation could not be loaded.",
    };
  }

  if (!consultationData) {
    console.warn(
      "Message notification permanently suppressed because the consultation is missing",
      {
        messageId: message.id,
        consultationId:
          message.consultation_id,
      },
    );

    return {
      ok: false,
      kind: "invalid",
      message:
        "The consultation was not found.",
    };
  }

const consultation =
  consultationData as unknown as ConsultationRow;

  if (!consultation.consultant_id) {
    console.warn(
      "Message notification permanently suppressed because no consultant is assigned",
      {
        messageId: message.id,
        consultationId:
          consultation.id,
      },
    );

    return {
      ok: false,
      kind: "invalid",
      message:
        "The consultation has no assigned consultant.",
    };
  }

  const {
    data: consultantData,
    error: consultantError,
  } = await supabaseAdmin
    .from("consultants")
    .select("id, profile_id")
    .eq(
      "id",
      consultation.consultant_id,
    )
    .maybeSingle();

  if (consultantError) {
    console.error(
      "Message consultant lookup failed",
      {
        messageId: message.id,
        consultationId:
          consultation.id,
        consultantId:
          consultation.consultant_id,
        code: consultantError.code,
        message: consultantError.message,
        details:
          consultantError.details,
        hint: consultantError.hint,
      },
    );

    return {
      ok: false,
      kind: "temporary",
      message:
        "The assigned consultant could not be loaded.",
    };
  }

  if (!consultantData) {
    console.warn(
      "Message notification permanently suppressed because the assigned consultant is missing",
      {
        messageId: message.id,
        consultationId:
          consultation.id,
        consultantId:
          consultation.consultant_id,
      },
    );

    return {
      ok: false,
      kind: "invalid",
      message:
        "The assigned consultant was not found.",
    };
  }

  const consultant =
    consultantData as ConsultantRow;

  const clientProfileId =
    consultation.client_profile_id;

  const consultantProfileId =
    consultant.profile_id;

  const participantsAreDistinct =
    clientProfileId !==
    consultantProfileId;

  const messageParticipantsAreDistinct =
    message.sender_profile_id !==
    message.recipient_profile_id;

  const senderIsParticipant =
    message.sender_profile_id ===
      clientProfileId ||
    message.sender_profile_id ===
      consultantProfileId;

  const recipientIsParticipant =
    message.recipient_profile_id ===
      clientProfileId ||
    message.recipient_profile_id ===
      consultantProfileId;

  const participantsAreOpposite =
    (message.sender_profile_id ===
      clientProfileId &&
      message.recipient_profile_id ===
        consultantProfileId) ||
    (message.sender_profile_id ===
      consultantProfileId &&
      message.recipient_profile_id ===
        clientProfileId);

  if (
    !participantsAreDistinct ||
    !messageParticipantsAreDistinct ||
    !senderIsParticipant ||
    !recipientIsParticipant ||
    !participantsAreOpposite
  ) {
    console.warn(
      "Message notification permanently suppressed because participant validation failed",
      {
        messageId: message.id,
        consultationId:
          consultation.id,
      },
    );

    return {
      ok: false,
      kind: "invalid",
      message:
        "The message participants are invalid.",
    };
  }

  return {
    ok: true,
    context: {
      consultation,
      clientProfileId,
      consultantProfileId,
    },
  };
};

const loadProfiles = async (
  message: MessageRow,
): Promise<LoadProfilesResult> => {
  const { data, error } =
    await supabaseAdmin
      .from("profiles")
      .select(
        "id, role, full_name, email",
      )
      .in("id", [
        message.sender_profile_id,
        message.recipient_profile_id,
      ]);

  if (error) {
    console.error(
      "Message participant profile lookup failed",
      {
        messageId: message.id,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      kind: "temporary",
      message:
        "The message participants could not be loaded.",
    };
  }

  const profiles =
    (data ?? []) as ProfileRow[];

  const senderProfile =
    profiles.find(
      (profile) =>
        profile.id ===
        message.sender_profile_id,
    );

  const recipientProfile =
    profiles.find(
      (profile) =>
        profile.id ===
        message.recipient_profile_id,
    );

  if (
    !senderProfile ||
    !recipientProfile
  ) {
    console.warn(
      "Message notification permanently suppressed because a participant profile is missing",
      {
        messageId: message.id,
      },
    );

    return {
      ok: false,
      kind: "invalid",
      message:
        "A message participant profile was not found.",
    };
  }

  return {
    ok: true,
    senderProfile,
    recipientProfile,
  };
};

const normalizeEmail = (
  value: string | null | undefined,
): string | null => {
  const normalized =
    value?.trim().toLowerCase() ?? "";

  if (
    normalized.length === 0 ||
    !normalized.includes("@")
  ) {
    return null;
  }

  return normalized;
};

const loadClientIntakeEmail = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      intake: IntakeRow | null;
    }
  | {
      ok: false;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultation_intake")
      .select("full_name, email")
      .eq(
        "consultation_id",
        consultationId,
      )
      .maybeSingle();

  if (error) {
    console.error(
      "Message client intake lookup failed",
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
    };
  }

  return {
    ok: true,
    intake:
      data as IntakeRow | null,
  };
};

const collapseWhitespace = (
  value: string,
): string =>
  value
    .trim()
    .replace(/\s+/g, " ");

const createPreview = (
  body: string,
): string => {
  const normalized =
    collapseWhitespace(body);

  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(
    0,
    239,
  )}…`;
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

const senderDisplayName = (
  senderProfile: ProfileRow,
): string => {
  const fullName =
    senderProfile.full_name?.trim();

  if (fullName) {
    return fullName;
  }

  if (
    senderProfile.role ===
    "consultant"
  ) {
    return "Your consultant";
  }

  if (
    senderProfile.role ===
    "client"
  ) {
    return "Your client";
  }

  return "A MakeHijrah user";
};

const buildPortalLink = ({
  recipientRole,
  consultationId,
}: {
  recipientRole: string;
  consultationId: string;
}): string | null => {
  const baseUrl =
    env.APP_URL.replace(/\/+$/, "");

  if (
    recipientRole === "client"
  ) {
    return (
      `${baseUrl}` +
      `/dashboard/consultation/` +
      `${consultationId}`
    );
  }

  if (
    recipientRole ===
    "consultant"
  ) {
    return (
      `${baseUrl}` +
      `/consultant/consultation/` +
      `${consultationId}`
    );
  }

  return null;
};

const markEmailNotificationSent =
  async (
    messageId: string,
    sentAt: string,
  ): Promise<
    | {
        ok: true;
      }
    | {
        ok: false;
      }
  > => {
    const { error } =
      await supabaseAdmin
        .from("messages")
        .update({
          email_notification_sent_at:
            sentAt,
        })
        .eq("id", messageId)
        .is("read_at", null)
        .is(
          "email_notification_sent_at",
          null,
        );

    if (error) {
      console.error(
        "Message notification sent timestamp update failed",
        {
          messageId,
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
    };
  };

export const scheduleMessageNotification =
  async ({
    messageId,
    senderProfileId,
  }: {
    messageId: string;
    senderProfileId: string;
  }): Promise<ScheduleMessageNotificationResult> => {
    const messageResult =
      await loadMessage(messageId);

    if (!messageResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The message notification could not be scheduled.",
      };
    }

    if (!messageResult.message) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "The message was not found.",
      };
    }

    const { message } =
      messageResult;

    if (
      message.sender_profile_id !==
      senderProfileId
    ) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          "You do not have permission to schedule this notification.",
      };
    }

    const participantResult =
      await loadParticipantContext(
        message,
      );

    if (!participantResult.ok) {
      if (
        participantResult.kind ===
        "temporary"
      ) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The message notification could not be scheduled.",
        };
      }

      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          "You do not have permission to schedule this notification.",
      };
    }

    if (message.read_at) {
      return {
        ok: true,
        messageId: message.id,
        notification:
          "suppressed",
      };
    }

    if (
      message
        .email_notification_sent_at
    ) {
      return {
        ok: true,
        messageId: message.id,
        notification:
          "already_sent",
      };
    }

    const createdAtMilliseconds =
      Date.parse(message.created_at);

    if (
      !Number.isFinite(
        createdAtMilliseconds,
      )
    ) {
      console.error(
        "Message notification schedule failed because created_at is invalid",
        {
          messageId: message.id,
          createdAt:
            message.created_at,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The message notification could not be scheduled.",
      };
    }

    const dueAtMilliseconds =
      createdAtMilliseconds +
      NOTIFICATION_DELAY_MS;

    try {
      await redis.zadd(
        MESSAGE_NOTIFICATION_DUE_SET,
        "NX",
        dueAtMilliseconds,
        message.id,
      );
    } catch (error) {
      console.error(
        "Message notification Redis scheduling failed",
        {
          messageId: message.id,
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
          "The message notification could not be scheduled.",
      };
    }

    return {
      ok: true,
      messageId: message.id,
      notification:
        "scheduled",
    };
  };

export const processMessageNotification =
  async (
    messageId: string,
  ): Promise<ProcessMessageNotificationResult> => {
    const messageResult =
      await loadMessage(messageId);

    if (!messageResult.ok) {
      return {
        ok: false,
        action: "retry",
        message:
          "The message could not be loaded.",
      };
    }

    if (!messageResult.message) {
      return {
        ok: true,
        action: "remove",
        outcome:
          "message_missing",
      };
    }

    const { message } =
      messageResult;

    if (message.read_at) {
      return {
        ok: true,
        action: "remove",
        outcome: "read",
      };
    }

    if (
      message
        .email_notification_sent_at
    ) {
      return {
        ok: true,
        action: "remove",
        outcome:
          "already_sent",
      };
    }

    const participantResult =
      await loadParticipantContext(
        message,
      );

    if (!participantResult.ok) {
      if (
        participantResult.kind ===
        "temporary"
      ) {
        return {
          ok: false,
          action: "retry",
          message:
            participantResult.message,
        };
      }

      return {
        ok: true,
        action: "remove",
        outcome:
          "permanent_failure",
      };
    }

    const profilesResult =
      await loadProfiles(message);

    if (!profilesResult.ok) {
      if (
        profilesResult.kind ===
        "temporary"
      ) {
        return {
          ok: false,
          action: "retry",
          message:
            profilesResult.message,
        };
      }

      return {
        ok: true,
        action: "remove",
        outcome:
          "permanent_failure",
      };
    }

    const {
      senderProfile,
      recipientProfile,
    } = profilesResult;

    const portalLink =
      buildPortalLink({
        recipientRole:
          recipientProfile.role,
        consultationId:
          message.consultation_id,
      });

    if (!portalLink) {
      console.warn(
        "Message notification permanently suppressed because the recipient role is unsupported",
        {
          messageId: message.id,
          recipientProfileId:
            recipientProfile.id,
          recipientRole:
            recipientProfile.role,
        },
      );

      return {
        ok: true,
        action: "remove",
        outcome:
          "permanent_failure",
      };
    }

    let recipientEmail =
      normalizeEmail(
        recipientProfile.email,
      );

    let recipientName =
      recipientProfile.full_name
        ?.trim() ?? "";

    if (
      !recipientEmail &&
      recipientProfile.role ===
        "client"
    ) {
      const intakeResult =
        await loadClientIntakeEmail(
          message.consultation_id,
        );

      if (!intakeResult.ok) {
        return {
          ok: false,
          action: "retry",
          message:
            "The recipient email could not be loaded.",
        };
      }

      recipientEmail =
        normalizeEmail(
          intakeResult.intake?.email,
        );

      if (!recipientName) {
        recipientName =
          intakeResult.intake
            ?.full_name
            ?.trim() ?? "";
      }
    }

    if (!recipientEmail) {
      console.warn(
        "Message notification permanently suppressed because the recipient has no usable email",
        {
          messageId: message.id,
          recipientProfileId:
            recipientProfile.id,
        },
      );

      return {
        ok: true,
        action: "remove",
        outcome:
          "permanent_failure",
      };
    }

    const senderName =
      senderDisplayName(
        senderProfile,
      );

    const preview =
      createPreview(message.body);

    const greeting =
      recipientName
        ? `Assalamu alaikum ${recipientName},`
        : "Assalamu alaikum,";

    const instruction =
      "Sign in to your MakeHijrah portal to read and reply. Replies to this email are not monitored.";

    const subject =
      "You have a new MakeHijrah message";

    const html =
      [
        `<p>${escapeHtml(
          greeting,
        )}</p>`,
        `<p>${escapeHtml(
          senderName,
        )} sent you a new message.</p>`,
        `<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid #669282;background:#f6f8f7;">${escapeHtml(
          preview,
        )}</blockquote>`,
        `<p><a href="${escapeHtml(
          portalLink,
        )}" style="display:inline-block;padding:10px 16px;background:#669282;color:#ffffff;text-decoration:none;">Read and reply</a></p>`,
        `<p>${escapeHtml(
          instruction,
        )}</p>`,
      ].join("");

    const text =
      [
        greeting,
        "",
        `${senderName} sent you a new message.`,
        "",
        preview,
        "",
        `Read and reply: ${portalLink}`,
        "",
        instruction,
      ].join("\n");

    const emailResult =
      await sendTransactionalEmail({
        to: {
          email:
            recipientEmail,
          name:
            recipientName ||
            null,
        },
        subject,
        html,
        text,
        tags: [
          "consultation-message",
        ],
      });

    if (!emailResult.ok) {
      console.error(
        "Message notification email failed",
        {
          messageId: message.id,
          recipientProfileId:
            recipientProfile.id,
          message:
            emailResult.message,
        },
      );

      return {
        ok: false,
        action: "retry",
        message:
          "The message notification email could not be sent.",
      };
    }

    const sentAt =
      new Date().toISOString();

    const updateResult =
      await markEmailNotificationSent(
        message.id,
        sentAt,
      );

    if (!updateResult.ok) {
      return {
        ok: false,
        action: "retry",
        message:
          "The notification delivery could not be recorded.",
      };
    }

    return {
      ok: true,
      action: "remove",
      outcome: "sent",
    };
  };
