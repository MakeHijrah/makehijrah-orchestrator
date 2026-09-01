import { env } from "../../config/env.js";
import {
  sendTransactionalEmail,
} from "../../lib/mandrill.js";
import { redis } from "../../lib/redis.js";
import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * "A client booked you" — the consultant half of the
 * payment-authorized row of the API contract's email map.
 *
 * Scheduled from the Stripe webhook and delivered by a worker,
 * never inline. The webhook path may not touch a table (Amendment
 * 004 section 10.3.3, asserted by the webhook tests, which throw on
 * any direct table access), so scheduling is Redis-only and every
 * database read happens later, in the worker.
 *
 * Idempotent by the done marker, not by the caller. Stripe
 * redelivers, and both scheduling and processing check the marker
 * first, so a consultant is emailed once per consultation however
 * many times the event arrives.
 */

export const BOOKING_NOTIFICATION_DUE_SET =
  "booking-notification:due";

export const BOOKING_NOTIFICATION_LOCK_PREFIX =
  "booking-notification:lock:";

const BOOKING_NOTIFICATION_PAYLOAD_PREFIX =
  "booking-notification:payload:";

const BOOKING_NOTIFICATION_DONE_PREFIX =
  "booking-notification:done:";

const PAYLOAD_TTL_SECONDS =
  7 * 24 * 60 * 60;

const DONE_TTL_SECONDS =
  30 * 24 * 60 * 60;

/*
 * The only two states in which "you have a new booking to accept"
 * is still true. Anything else means the consultant has already
 * acted, or there is nothing left to act on, and the notification
 * is dropped rather than sent late.
 */
const NOTIFIABLE_STATUSES =
  new Set([
    "payment_authorized",
    "pending_acceptance",
  ]);

type BookingNotificationPayload = {
  consultationId: string;
  queuedAt: string;
};

type ConsultationRow = {
  id: string;
  consultant_id: string;
  country_id: string | null;
  status: string;
  scheduled_start_at: string;
  payment_authorized_at: string | null;
  price_cents: number;
  currency: string;
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

type IntakeRow = {
  full_name: string;
};

type NotificationContext = {
  consultation: ConsultationRow;
  consultantProfile: ProfileRow;
  clientName: string;
  countryName: string | null;
};

export type ScheduleBookingNotificationResult =
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

export type ProcessBookingNotificationResult =
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
  `${BOOKING_NOTIFICATION_PAYLOAD_PREFIX}${consultationId}`;

const doneKey = (
  consultationId: string,
): string =>
  `${BOOKING_NOTIFICATION_DONE_PREFIX}${consultationId}`;

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

const formatAmount = (
  priceCents: number,
  currency: string,
): string => {
  const amount =
    (priceCents / 100).toFixed(2);

  return `${amount} ${currency.toUpperCase()}`;
};

const loadPayload = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      payload:
        | BookingNotificationPayload
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
      ) as Partial<BookingNotificationPayload>;

    if (
      parsed.consultationId !==
        consultationId ||
      typeof parsed.queuedAt !==
        "string"
    ) {
      console.error(
        "Booking notification payload is invalid",
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
        queuedAt:
          parsed.queuedAt,
      },
    };
  } catch (error) {
    console.error(
      "Booking notification payload lookup failed",
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
        "The booking notification payload could not be loaded.",
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
          "consultant_id",
          "country_id",
          "status",
          "scheduled_start_at",
          "payment_authorized_at",
          "price_cents",
          "currency",
        ].join(", "),
      )
      .eq(
        "id",
        consultationId,
      )
      .maybeSingle();

    if (consultationError) {
      console.error(
        "Booking notification consultation lookup failed",
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
          "The booked consultation could not be loaded.",
      };
    }

    if (!consultationData) {
      console.warn(
        "Booking notification suppressed because the consultation is missing",
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
      !consultation.payment_authorized_at
    ) {
      console.warn(
        "Booking notification suppressed because the payment is not authorized",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultation payment is not authorized.",
      };
    }

    /*
     * Not an error. Between the webhook scheduling this and the
     * worker picking it up, the consultant may have accepted or
     * declined, or the authorization may have been cancelled.
     * In every one of those cases the email would be telling them
     * to do something they have already done or can no longer do,
     * so it is dropped permanently instead of sent.
     */
    if (
      !NOTIFIABLE_STATUSES.has(
        consultation.status,
      )
    ) {
      console.warn(
        "Booking notification suppressed because the consultation is no longer awaiting the consultant",
        {
          consultationId,
          status:
            consultation.status,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultation is no longer awaiting the consultant.",
      };
    }

    const {
      data: consultantData,
      error: consultantError,
    } = await supabaseAdmin
      .from("consultants")
      .select(
        "id, profile_id",
      )
      .eq(
        "id",
        consultation.consultant_id,
      )
      .maybeSingle();

    if (consultantError) {
      console.error(
        "Booking notification consultant lookup failed",
        {
          consultationId,
          code:
            consultantError.code,
          message:
            consultantError.message,
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
      console.error(
        "Booking notification suppressed because the consultant is missing",
        {
          consultationId,
          consultantId:
            consultation.consultant_id,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultant was not found.",
      };
    }

    const consultant =
      consultantData as unknown as ConsultantRow;

    const {
      data: profileData,
      error: profileError,
    } = await supabaseAdmin
      .from("profiles")
      .select(
        "id, full_name, email",
      )
      .eq(
        "id",
        consultant.profile_id,
      )
      .maybeSingle();

    if (profileError) {
      console.error(
        "Booking notification consultant profile lookup failed",
        {
          consultationId,
          code:
            profileError.code,
          message:
            profileError.message,
        },
      );

      return {
        ok: false,
        kind: "temporary",
        message:
          "The consultant profile could not be loaded.",
      };
    }

    if (!profileData) {
      console.error(
        "Booking notification suppressed because the consultant profile is missing",
        {
          consultationId,
          consultantId:
            consultant.id,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultant profile was not found.",
      };
    }

    const consultantProfile =
      profileData as unknown as ProfileRow;

    if (
      !isUsableEmail(
        consultantProfile.email,
      )
    ) {
      console.error(
        "Booking notification suppressed because the consultant email is invalid",
        {
          consultationId,
          consultantId:
            consultant.id,
        },
      );

      return {
        ok: false,
        kind: "permanent",
        message:
          "The consultant email is invalid.",
      };
    }

    /*
     * Intake and country are context, not preconditions. A booking
     * the consultant needs to accept is still worth telling them
     * about if either lookup comes back empty, so both fall back
     * rather than suppress.
     */
    const {
      data: intakeData,
    } = await supabaseAdmin
      .from(
        "consultation_intake",
      )
      .select(
        "full_name",
      )
      .eq(
        "consultation_id",
        consultationId,
      )
      .maybeSingle();

    const clientName =
      (
        intakeData as IntakeRow | null
      )?.full_name?.trim() ||
      "A client";

    let countryName:
      | string
      | null = null;

    if (consultation.country_id) {
      const {
        data: countryData,
      } = await supabaseAdmin
        .from("countries")
        .select("name")
        .eq(
          "id",
          consultation.country_id,
        )
        .maybeSingle();

      countryName =
        (
          countryData as
            | { name: string }
            | null
        )?.name?.trim() || null;
    }

    return {
      ok: true,
      context: {
        consultation,
        consultantProfile,
        clientName,
        countryName,
      },
    };
  };

const sendConsultantNotification =
  async ({
    consultationId,
    context,
  }: {
    consultationId: string;
    context: NotificationContext;
  }): Promise<boolean> => {
    const consultantName =
      context.consultantProfile
        .full_name?.trim() ||
      "there";

    const scheduledTime =
      formatScheduledTime(
        context.consultation
          .scheduled_start_at,
      );

    const amount =
      formatAmount(
        context.consultation
          .price_cents,
        context.consultation
          .currency,
      );

    const subject =
      context.countryName
        ? `New booking to accept — ${context.countryName}`
        : "New booking to accept";

    const topic =
      context.countryName ??
      "General information";

    const consultantUrl =
      `${env.APP_URL.replace(
        /\/+$/,
        "",
      )}/consultant`;

    const result =
      await sendTransactionalEmail({
        to: {
          email:
            normalizeEmail(
              context.consultantProfile
                .email,
            ),
          name:
            context.consultantProfile
              .full_name ??
            undefined,
        },
        subject,
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
            <h1 style="font-family:Georgia,serif;color:#364355;">You have a new booking</h1>
            <p>As-salāmu ʿalaykum ${escapeHtml(consultantName)},</p>
            <p><strong>${escapeHtml(context.clientName)}</strong> has booked a consultation with you and their payment has been authorised.</p>
            <div style="border:1px solid #d9e2de;padding:20px;margin:24px 0;">
              <p><strong>Scheduled time:</strong><br>${escapeHtml(scheduledTime)}</p>
              <p><strong>Topic:</strong><br>${escapeHtml(topic)}</p>
              <p><strong>Session fee:</strong><br>${escapeHtml(amount)}</p>
            </div>
            <p><strong>Please accept or decline within 48 hours.</strong> The client is not charged until you accept, and an authorisation left unanswered is cancelled automatically.</p>
            <p>
              <a href="${escapeHtml(consultantUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
                Review this booking
              </a>
            </p>
            <p>MakeHijrah Consultations</p>
          </div>
        `,
        text: [
          `As-salāmu ʿalaykum ${consultantName},`,
          "",
          `${context.clientName} has booked a consultation with you and their payment has been authorised.`,
          "",
          `Scheduled time: ${scheduledTime}`,
          `Topic: ${topic}`,
          `Session fee: ${amount}`,
          "",
          "Please accept or decline within 48 hours. The client is not charged until you accept, and an authorisation left unanswered is cancelled automatically.",
          "",
          `Review this booking: ${consultantUrl}`,
          "",
          "MakeHijrah Consultations",
        ].join("\n"),
        tags: [
          "consultation-booked-consultant",
        ],
      });

    if (!result.ok) {
      console.error(
        "Consultant booking notification delivery failed",
        {
          consultationId,
          consultantId:
            context.consultation
              .consultant_id,
          message:
            result.message,
        },
      );

      return false;
    }

    return true;
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
        .exec();

      return true;
    } catch (error) {
      console.error(
        "Booking notification completion marker write failed",
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

export const scheduleBookingNotification =
  async ({
    consultationId,
  }: {
    consultationId: string;
  }): Promise<ScheduleBookingNotificationResult> => {
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

      const payload: BookingNotificationPayload =
        {
          consultationId,
          queuedAt:
            new Date().toISOString(),
        };

      /*
       * Both writes are NX. A Stripe redelivery that arrives
       * before the worker has run finds the payload already
       * present and leaves the original queue position alone
       * rather than pushing the notification further out.
       */
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
            BOOKING_NOTIFICATION_DUE_SET,
            "NX",
            Date.now(),
            consultationId,
          )
          .exec();

      const payloadWritten =
        result?.[0]?.[1] === "OK";

      return {
        ok: true,
        consultationId,
        notification:
          payloadWritten
            ? "scheduled"
            : "already_scheduled",
      };
    } catch (error) {
      console.error(
        "Booking notification scheduling failed",
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
          "The booking notification could not be scheduled.",
      };
    }
  };

export const processBookingNotification =
  async (
    consultationId: string,
  ): Promise<ProcessBookingNotificationResult> => {
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
        "Booking notification completion lookup failed",
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
          "The booking notification state could not be checked.",
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
        /*
         * Marked done as well as removed. A suppressed booking
         * must not be revived by a later Stripe redelivery
         * re-scheduling the same consultation.
         */
        await markNotificationDone(
          consultationId,
        );

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

    const sent =
      await sendConsultantNotification(
        {
          consultationId,
          context:
            contextResult.context,
        },
      );

    if (!sent) {
      return {
        ok: false,
        action: "retry",
        message:
          "The consultant booking notification could not be delivered.",
      };
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
          "The booking notification completion could not be recorded.",
      };
    }

    return {
      ok: true,
      action: "remove",
      outcome: "sent",
    };
  };
