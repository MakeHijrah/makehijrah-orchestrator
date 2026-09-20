import { env } from "../../config/env.js";
import { sendTransactionalEmail } from "../../lib/mandrill.js";
import { redis } from "../../lib/redis.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { loadDirectBookingSettingsById } from "../direct-booking/direct-booking.repository.js";
import { buildPublicBookingDestinationUrl } from "../direct-booking/direct-booking.slug.js";

/*
 * The client-requested cancellation follow-up email. Migration 058.
 *
 * Fires only when an admin has cancelled a consultation with
 * cancellation_source = 'client_requested' — never for an admin's
 * own decision, never for a system path, and never inferred from
 * free text. That decision is made by the caller
 * (admin-consultation-cancel.service.ts), reading the value the
 * RPC actually stored; this file only sends, once, when asked to.
 *
 * Modelled directly on admin-consultation-cancel-notification.
 * service.ts: same Redis delivery-key idempotency, same
 * consultation_intake.email recipient, same HTML + text
 * conventions, same fire-and-log-on-failure behaviour. A separate
 * delivery key and a separate file, not a branch inside the
 * existing one, because this email has a different audience
 * (client only), a different purpose (asking what happened, not
 * confirming an outcome), and a different trigger (one specific
 * cancellation source, not every cancellation).
 */

const DELIVERY_PREFIX =
  "client-cancellation-followup:delivery:";

const DELIVERY_TTL_SECONDS =
  30 * 24 * 60 * 60;

type ConsultationRow = {
  id: string;
  consultant_id: string;
  booking_source: string;
  status: string;
  cancellation_source: string | null;
};

type IntakeRow = {
  full_name: string;
  email: string;
};

export type ClientCancellationFollowUpResult =
  | "sent"
  | "already_sent"
  | "skipped"
  | "failed";

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

/*
 * The first token of the name the client typed at booking.
 * "there" is the same safe fallback this codebase already uses
 * (admin-consultation-cancel-notification.service.ts) for a name
 * that turns out to be blank — the check runs after trimming, so
 * a name that is only whitespace falls back the same way as one
 * that is empty.
 */
const firstNameFrom = (
  fullName: string,
): string => {
  const trimmed = fullName.trim();

  if (!trimmed) {
    return "there";
  }

  return trimmed.split(/\s+/)[0] as string;
};

const deliveryKey = (
  consultationId: string,
): string =>
  `${DELIVERY_PREFIX}${consultationId}`;

const deliveryWasRecorded = async (
  consultationId: string,
): Promise<boolean> => {
  try {
    return (
      (await redis.get(
        deliveryKey(consultationId),
      )) === "sent"
    );
  } catch (error) {
    console.error(
      "Client cancellation follow-up delivery lookup failed",
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

const recordDelivery = async (
  consultationId: string,
): Promise<boolean> => {
  try {
    await redis.set(
      deliveryKey(consultationId),
      "sent",
      "EX",
      DELIVERY_TTL_SECONDS,
    );

    return true;
  } catch (error) {
    console.error(
      "Client cancellation follow-up delivery write failed",
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

/*
 * Where the "book another consultation" link goes. Reads the
 * consultant's slug only for a direct booking, exactly as
 * checkout.service.ts does for its own cancel-and-return URL —
 * the slug is READ, never re-derived, because regenerating it
 * from a name could point at a different consultant than the one
 * this booking actually belonged to.
 *
 * Returns null rather than a best-guess URL when a direct
 * booking's consultant has no usable slug, so the email omits the
 * rebook line entirely rather than link somewhere wrong. This
 * should not happen — activation requires a slug — but a
 * follow-up email is not the place to surface that as an error.
 */
const resolveRebookUrl = async (
  consultation: ConsultationRow,
): Promise<string | null> => {
  if (
    consultation.booking_source !==
    "direct_booking"
  ) {
    return buildPublicBookingDestinationUrl({
      appUrl: env.APP_URL,
      consultantSlug: null,
    });
  }

  const consultantRecord =
    await loadDirectBookingSettingsById(
      consultation.consultant_id,
    );

  if (!consultantRecord.ok) {
    return null;
  }

  const consultantSlug =
    consultantRecord.data
      ?.consultant_slug ?? null;

  if (!consultantSlug) {
    return null;
  }

  return buildPublicBookingDestinationUrl({
    appUrl: env.APP_URL,
    consultantSlug,
  });
};

const loadContext = async (
  consultationId: string,
): Promise<
  | {
      consultation: ConsultationRow;
      intake: IntakeRow;
    }
  | null
> => {
  const {
    data: consultationData,
    error: consultationError,
  } = await supabaseAdmin
    .from("consultations")
    .select(
      "id, consultant_id, booking_source, status, cancellation_source",
    )
    .eq("id", consultationId)
    .maybeSingle();

  if (
    consultationError ||
    !consultationData
  ) {
    console.error(
      "Client cancellation follow-up consultation lookup failed",
      {
        consultationId,
        code: consultationError?.code,
        message:
          consultationError?.message,
      },
    );

    return null;
  }

  const consultation =
    consultationData as unknown as ConsultationRow;

  /*
   * Re-checked here, not only by the caller. This function is the
   * one place that actually sends the email, so it is the one
   * place a bad call — a future caller that forgets the
   * condition, a direct invocation from a test or a script —
   * cannot bypass the rule this whole feature exists to enforce.
   */
  if (
    consultation.status !== "cancelled" ||
    consultation.cancellation_source !==
      "client_requested"
  ) {
    console.warn(
      "Client cancellation follow-up suppressed: not a client-requested cancellation",
      {
        consultationId,
        status: consultation.status,
        cancellationSource:
          consultation.cancellation_source,
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
    .eq("consultation_id", consultationId)
    .maybeSingle();

  if (intakeError || !intakeData) {
    console.error(
      "Client cancellation follow-up intake lookup failed",
      {
        consultationId,
        code: intakeError?.code,
        message: intakeError?.message,
      },
    );

    return null;
  }

  return {
    consultation,
    intake:
      intakeData as unknown as IntakeRow,
  };
};

export const sendClientCancellationFollowUpEmail =
  async ({
    consultationId,
  }: {
    consultationId: string;
  }): Promise<ClientCancellationFollowUpResult> => {
    if (
      await deliveryWasRecorded(
        consultationId,
      )
    ) {
      return "already_sent";
    }

    const context =
      await loadContext(consultationId);

    if (!context) {
      return "skipped";
    }

    if (
      !isUsableEmail(
        context.intake.email,
      )
    ) {
      return "skipped";
    }

    const firstName = firstNameFrom(
      context.intake.full_name,
    );

    const rebookUrl =
      await resolveRebookUrl(
        context.consultation,
      );

    /*
     * No urgency, no discount, no internal reason. The admin note
     * and admin_attention_reason are deliberately never read here
     * — a client must never see the internal record of why their
     * own cancellation was processed.
     */
    const rebookHtml = rebookUrl
      ? `<p>If you'd like to reschedule, you can <a href="${escapeHtml(rebookUrl)}" style="color:#669282;">book another consultation here</a>.</p>`
      : "";

    const rebookText = rebookUrl
      ? `\n\nIf you'd like to reschedule, you can book another consultation here: ${rebookUrl}`
      : "";

    const result =
      await sendTransactionalEmail({
        to: {
          email: normalizeEmail(
            context.intake.email,
          ),
          name: firstName,
        },
        subject:
          "We noticed you cancelled your Make Hijrah consultation",
        html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
          <p>Assalamu alaikum ${escapeHtml(firstName)},</p>
          <p>We noticed that you cancelled your consultation with Make Hijrah.</p>
          <p>We completely understand that plans can change, but we wanted to check in and see if there was anything that caused you to cancel or anything we could have done differently.</p>
          <p>If you ran into a scheduling issue, had a question, or there is anything we can help with, we'd be grateful to hear from you.</p>
          <p>Your feedback helps us improve the experience for others planning their Hijrah.</p>
          ${rebookHtml}
          <p>JazakAllahu khayran,<br>The Make Hijrah Team</p>
        </div>
      `,
        text: [
          `Assalamu alaikum ${firstName},`,
          "",
          "We noticed that you cancelled your consultation with Make Hijrah.",
          "",
          "We completely understand that plans can change, but we wanted to check in and see if there was anything that caused you to cancel or anything we could have done differently.",
          "",
          "If you ran into a scheduling issue, had a question, or there is anything we can help with, we'd be grateful to hear from you.",
          "",
          "Your feedback helps us improve the experience for others planning their Hijrah.",
          `${rebookText}`,
          "",
          "JazakAllahu khayran,",
          "The Make Hijrah Team",
        ].join("\n"),
        tags: ["consultation-cancellation-followup-client"],
      });

    if (!result.ok) {
      console.error(
        "Client cancellation follow-up email failed",
        {
          consultationId,
          message: result.message,
        },
      );

      return "failed";
    }

    return (await recordDelivery(
      consultationId,
    ))
      ? "sent"
      : "failed";
  };
