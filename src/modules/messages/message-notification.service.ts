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

/*
 * consultation_id is nullable since migration 023.
 *
 * It is the sole classifier for the two message classes:
 * - not null -> consultation message
 * - null     -> direct admin <-> consultant message
 *
 * The class is never taken from anything a client supplies.
 */
type MessageRow = {
  id: string;
  consultation_id: string | null;
  sender_profile_id: string;
  recipient_profile_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  email_notification_sent_at: string | null;
};

type ConsultationMessageRow = MessageRow & {
  consultation_id: string;
};

type DirectRole =
  | "admin"
  | "consultant";

type DirectPairing = {
  senderProfile: ProfileRow;
  recipientProfile: ProfileRow;
  senderRole: DirectRole;
  recipientRole: DirectRole;
};

const isConsultationMessage = (
  message: MessageRow,
): message is ConsultationMessageRow =>
  message.consultation_id !== null;

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
  message: ConsultationMessageRow,
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

  let protectedPath: string;

  if (
    recipientRole === "client"
  ) {
    protectedPath =
      `/dashboard/consultation/${consultationId}`;
  } else if (
    recipientRole ===
    "consultant"
  ) {
    protectedPath =
      `/consultant/consultation/${consultationId}`;
  } else {
    return null;
  }

  return (
    `${baseUrl}/login?redirect=` +
    encodeURIComponent(
      protectedPath,
    )
  );
};

/*
 * Direct-message portal links.
 *
 * Follows the same protected-link convention as consultation
 * links: the recipient lands on /login and is redirected to the
 * protected path after authenticating.
 */
const buildDirectPortalLink = (
  recipientRole: DirectRole,
): string => {
  const baseUrl =
    env.APP_URL.replace(/\/+$/, "");

  const protectedPath =
    recipientRole === "admin"
      ? "/admin/messages"
      : "/consultant/messages";

  return (
    `${baseUrl}/login?redirect=` +
    encodeURIComponent(
      protectedPath,
    )
  );
};

type ValidateDirectPairingResult =
  | {
      ok: true;
      pairing: DirectPairing;
    }
  | {
      ok: false;
      kind: "invalid" | "temporary";
      message: string;
    };

/*
 * Direct-message role pairing, resolved entirely from
 * public.profiles.
 *
 * Amendment 006 section 3.5: the pair is never classified or
 * authorised by anything a client supplies. Requires exactly one
 * admin and exactly one consultant, which by construction also
 * rejects any client participation, consultant <-> consultant and
 * admin <-> admin.
 */
const validateDirectPairing = async (
  message: MessageRow,
): Promise<ValidateDirectPairingResult> => {
  const profilesResult =
    await loadProfiles(message);

  if (!profilesResult.ok) {
    return {
      ok: false,
      kind: profilesResult.kind,
      message:
        profilesResult.message,
    };
  }

  const {
    senderProfile,
    recipientProfile,
  } = profilesResult;

  if (
    message.sender_profile_id ===
      message.recipient_profile_id ||
    senderProfile.id ===
      recipientProfile.id
  ) {
    console.warn(
      "Direct message notification permanently suppressed because the sender and recipient are the same profile",
      {
        messageId: message.id,
      },
    );

    return {
      ok: false,
      kind: "invalid",
      message:
        "A direct message may not be sent to yourself.",
    };
  }

  const roles = [
    senderProfile.role,
    recipientProfile.role,
  ];

  const adminCount = roles.filter(
    (role) => role === "admin",
  ).length;

  const consultantCount =
    roles.filter(
      (role) =>
        role === "consultant",
    ).length;

  if (
    adminCount !== 1 ||
    consultantCount !== 1
  ) {
    console.warn(
      "Direct message notification permanently suppressed because the participant roles are not exactly one admin and one consultant",
      {
        messageId: message.id,
        senderRole:
          senderProfile.role,
        recipientRole:
          recipientProfile.role,
      },
    );

    return {
      ok: false,
      kind: "invalid",
      message:
        "Direct messages are permitted only between an admin and a consultant.",
    };
  }

  return {
    ok: true,
    pairing: {
      senderProfile,
      recipientProfile,
      senderRole:
        senderProfile.role as DirectRole,
      recipientRole:
        recipientProfile.role as DirectRole,
    },
  };
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

    /*
     * Classification is taken from the stored row, never from the
     * request. Consultation messages keep the existing participant
     * validation untouched; direct messages use the admin <->
     * consultant pairing rules.
     */
    const validationResult =
      isConsultationMessage(message)
        ? await loadParticipantContext(
            message,
          )
        : await validateDirectPairing(
            message,
          );

    if (!validationResult.ok) {
      if (
        validationResult.kind ===
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

/*
 * Consultation-message delivery.
 *
 * Preserved exactly as it behaved before direct messages existed:
 * the same participant validation, expected recipient role,
 * subject, sender display name, client intake fallback, portal
 * link and consultation-message tag. No metadata is attached.
 */
const processConsultationMessage =
  async (
    message: ConsultationMessageRow,
  ): Promise<ProcessMessageNotificationResult> => {
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

    const {
      clientProfileId,
      consultantProfileId,
    } = participantResult.context;

    const expectedRecipientRole =
      message.recipient_profile_id ===
      clientProfileId
        ? "client"
        : message.recipient_profile_id ===
            consultantProfileId
          ? "consultant"
          : null;

    if (
      !expectedRecipientRole ||
      recipientProfile.role !==
        expectedRecipientRole
    ) {
      console.warn(
        "Message notification permanently suppressed because the recipient role does not match the consultation participant",
        {
          messageId: message.id,
          consultationId:
            message.consultation_id,
          recipientProfileId:
            recipientProfile.id,
          recipientRole:
            recipientProfile.role,
          expectedRecipientRole,
        },
      );

      return {
        ok: true,
        action: "remove",
        outcome:
          "permanent_failure",
      };
    }

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

/*
 * Direct admin <-> consultant message delivery.
 *
 * Uses the same delayed pipeline, the same read suppression and
 * the same single idempotency marker as consultation messages.
 * Only the addressing, copy, portal link, tag and metadata differ.
 */
const processDirectMessage = async (
  message: MessageRow,
): Promise<ProcessMessageNotificationResult> => {
  const pairingResult =
    await validateDirectPairing(
      message,
    );

  if (!pairingResult.ok) {
    if (
      pairingResult.kind ===
      "temporary"
    ) {
      return {
        ok: false,
        action: "retry",
        message:
          pairingResult.message,
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
    senderRole,
    recipientRole,
  } = pairingResult.pairing;

  const recipientEmail =
    normalizeEmail(
      recipientProfile.email,
    );

  /*
   * There is no intake fallback here. Clients are excluded from
   * direct messaging, and intake rows belong to consultations.
   */
  if (!recipientEmail) {
    console.warn(
      "Direct message notification permanently suppressed because the recipient has no usable email",
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

  const recipientName =
    recipientProfile.full_name?.trim() ??
    "";

  const portalLink =
    buildDirectPortalLink(
      recipientRole,
    );

  /*
   * Amendment 006 section 6.
   *
   * An admin sender is always presented as the organisation, never
   * by personal name. A consultant sender uses their full name
   * when one is recorded.
   */
  const senderName =
    senderRole === "admin"
      ? "MakeHijrah Administration"
      : senderProfile.full_name?.trim() ||
        "A MakeHijrah consultant";

  const subject =
    senderRole === "admin"
      ? "MakeHijrah Administration sent you a message"
      : "A MakeHijrah consultant sent you a message";

  const preview = createPreview(
    message.body,
  );

  const greeting = recipientName
    ? `Assalamu alaikum ${recipientName},`
    : "Assalamu alaikum,";

  const instruction =
    "Sign in to your MakeHijrah portal to read and reply. Replies to this email are not monitored.";

  const html = [
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

  const text = [
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

  /*
   * Metadata carries identifiers and roles only. No body, no
   * consultation identifier, no email address, no name, no token
   * and no URL parameters.
   */
  const emailResult =
    await sendTransactionalEmail({
      to: {
        email: recipientEmail,
        name:
          recipientName || null,
      },
      subject,
      html,
      text,
      tags: ["direct-message"],
      metadata: {
        message_id: message.id,
        sender_role: senderRole,
        recipient_role:
          recipientRole,
      },
    });

  if (!emailResult.ok) {
    console.error(
      "Direct message notification email failed",
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

    /*
     * Read suppression is re-checked here, after the delay, so a
     * message read during the wait is never emailed.
     */
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

    return isConsultationMessage(
      message,
    )
      ? processConsultationMessage(
          message,
        )
      : processDirectMessage(
          message,
        );
  };
