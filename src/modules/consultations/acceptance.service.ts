import type Stripe from "stripe";
import { stripe } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { getGoogleAccessToken } from "../oauth/google-access-token.js";
import { createConsultationCalendarEvent } from "./google-calendar-event.service.js";

const ACCEPTANCE_WINDOW_MILLISECONDS =
  48 * 60 * 60 * 1000;

type AcceptanceConsultationRow = {
  id: string;
  consultant_id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  client_timezone: string;
  stripe_payment_intent_id: string | null;
  payment_authorized_at: string | null;
  google_event_id: string | null;
  meet_link: string | null;
};

export type AcceptConsultationResult =
  | {
      ok: true;
      consultationId: string;
      status: string;
      googleEventId: string;
      meetLink: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INVALID_TRANSITION"
        | "ACCEPTANCE_EXPIRED"
        | "PAYMENT_NOT_AUTHORIZED"
        | "STRIPE_ERROR"
        | "GOOGLE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const loadAcceptanceConsultation = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      consultation: AcceptanceConsultationRow;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultations")
      .select(
        "id, consultant_id, status, scheduled_start_at, scheduled_end_at, client_timezone, stripe_payment_intent_id, payment_authorized_at, google_event_id, meet_link",
      )
      .eq("id", consultationId)
      .maybeSingle();

  if (error) {
    console.error(
      "Acceptance consultation lookup failed",
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
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be loaded.",
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The consultation was not found.",
    };
  }

  return {
    ok: true,
    consultation:
      data as unknown as AcceptanceConsultationRow,
  };
};

const markAdminAttention = async ({
  consultationId,
  reason,
}: {
  consultationId: string;
  reason: string;
}): Promise<void> => {
  const { error } =
    await supabaseAdmin
      .from("consultations")
      .update({
        status: "admin_attention",
        admin_attention_reason: reason,
        updated_at:
          new Date().toISOString(),
      })
      .eq("id", consultationId)
      .in("status", [
        "pending_acceptance",
        "captured",
      ]);

  if (error) {
    console.error(
      "Failed to mark consultation for admin attention",
      {
        consultationId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );
  }
};

const capturePaymentIntent = async (
  paymentIntentId: string,
): Promise<
  | {
      ok: true;
      paymentIntent: Stripe.PaymentIntent;
    }
  | {
      ok: false;
      code:
        | "PAYMENT_NOT_AUTHORIZED"
        | "STRIPE_ERROR";
      message: string;
    }
> => {
  let paymentIntent: Stripe.PaymentIntent;

  try {
    paymentIntent =
      await stripe.paymentIntents.retrieve(
        paymentIntentId,
      );
  } catch (error) {
    console.error(
      "Stripe PaymentIntent retrieval failed during acceptance",
      {
        paymentIntentId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Stripe error",
      },
    );

    return {
      ok: false,
      code: "STRIPE_ERROR",
      message:
        "The payment authorization could not be verified.",
    };
  }

  if (
    paymentIntent.status ===
    "succeeded"
  ) {
    return {
      ok: true,
      paymentIntent,
    };
  }

  if (
    paymentIntent.status !==
    "requires_capture"
  ) {
    return {
      ok: false,
      code: "PAYMENT_NOT_AUTHORIZED",
      message:
        "The consultation payment is not available for capture.",
    };
  }

  try {
    const capturedPaymentIntent =
      await stripe.paymentIntents.capture(
        paymentIntentId,
        {},
        {
          idempotencyKey:
            `consultation-accept-${paymentIntentId}`,
        },
      );

    return {
      ok: true,
      paymentIntent:
        capturedPaymentIntent,
    };
  } catch (error) {
    console.error(
      "Stripe PaymentIntent capture failed during acceptance",
      {
        paymentIntentId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Stripe error",
      },
    );

    return {
      ok: false,
      code: "STRIPE_ERROR",
      message:
        "The consultation payment could not be captured.",
    };
  }
};

const finalizeAcceptance = async ({
  consultationId,
  consultantId,
  googleEventId,
  meetLink,
}: {
  consultationId: string;
  consultantId: string;
  googleEventId: string;
  meetLink: string;
}): Promise<
  | {
      ok: true;
      status: string;
      googleEventId: string;
      meetLink: string;
    }
  | {
      ok: false;
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin.rpc(
      "finalize_consultation_acceptance",
      {
        p_consultation_id:
          consultationId,
        p_consultant_id:
          consultantId,
        p_google_event_id:
          googleEventId,
        p_meet_link:
          meetLink,
      },
    );

  if (error) {
    console.error(
      "Consultation acceptance RPC failed",
      {
        consultationId,
        consultantId,
        googleEventId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      message:
        "The consultation acceptance could not be finalized.",
    };
  }

  const row =
    (
      data as unknown as
        | Array<{
            consultation_status: string;
            google_event_id: string;
            meet_link: string;
          }>
        | null
    )?.[0];

  if (!row) {
    return {
      ok: false,
      message:
        "The consultation acceptance returned no result.",
    };
  }

  return {
    ok: true,
    status:
      row.consultation_status,
    googleEventId:
      row.google_event_id,
    meetLink:
      row.meet_link,
  };
};

export const acceptConsultation =
  async ({
    consultationId,
    consultantId,
  }: {
    consultationId: string;
    consultantId: string;
  }): Promise<AcceptConsultationResult> => {
    const consultationResult =
      await loadAcceptanceConsultation(
        consultationId,
      );

    if (!consultationResult.ok) {
      return consultationResult;
    }

    const { consultation } =
      consultationResult;

    if (
      consultation.consultant_id !==
      consultantId
    ) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          "You do not have permission to accept this consultation.",
      };
    }

    if (
      consultation.status ===
        "confirmed" &&
      consultation.google_event_id &&
      consultation.meet_link
    ) {
      return {
        ok: true,
        consultationId:
          consultation.id,
        status:
          consultation.status,
        googleEventId:
          consultation.google_event_id,
        meetLink:
          consultation.meet_link,
      };
    }

    if (
      consultation.status !==
        "pending_acceptance" &&
      consultation.status !==
        "captured"
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The consultation cannot be accepted from its current status.",
      };
    }

    const paymentAuthorizedAt =
      consultation.payment_authorized_at
        ? Date.parse(
            consultation.payment_authorized_at,
          )
        : Number.NaN;

    if (
      !Number.isFinite(
        paymentAuthorizedAt,
      )
    ) {
      return {
        ok: false,
        code: "PAYMENT_NOT_AUTHORIZED",
        message:
          "The consultation payment authorization is missing.",
      };
    }

    if (
      Date.now() >
      paymentAuthorizedAt +
        ACCEPTANCE_WINDOW_MILLISECONDS
    ) {
      return {
        ok: false,
        code: "ACCEPTANCE_EXPIRED",
        message:
          "The consultation acceptance window has expired.",
      };
    }

    const paymentIntentId =
      consultation
        .stripe_payment_intent_id
        ?.trim();

    if (!paymentIntentId) {
      return {
        ok: false,
        code: "PAYMENT_NOT_AUTHORIZED",
        message:
          "The consultation has no payment authorization.",
      };
    }

    const googleAccessResult =
      await getGoogleAccessToken(
        consultantId,
      );

    if (!googleAccessResult.ok) {
      return {
        ok: false,
        code: "GOOGLE_ERROR",
        message:
          googleAccessResult.code ===
            "OAUTH_NOT_CONNECTED" ||
          googleAccessResult.code ===
            "OAUTH_REVOKED"
            ? "Reconnect Google Calendar before accepting consultations."
            : googleAccessResult.message,
      };
    }

    const captureResult =
      await capturePaymentIntent(
        paymentIntentId,
      );

    if (!captureResult.ok) {
      return captureResult;
    }

    const calendarResult =
      await createConsultationCalendarEvent({
        consultationId:
          consultation.id,
        consultantId,
        scheduledStartAt:
          consultation.scheduled_start_at,
        scheduledEndAt:
          consultation.scheduled_end_at,
        clientTimezone:
          consultation.client_timezone,
      });

    if (!calendarResult.ok) {
      await markAdminAttention({
        consultationId:
          consultation.id,
        reason: "calendar_failed",
      });

      return {
        ok: false,
        code: "GOOGLE_ERROR",
        message:
          calendarResult.message,
      };
    }

    const finalizationResult =
      await finalizeAcceptance({
        consultationId:
          consultation.id,
        consultantId,
        googleEventId:
          calendarResult.googleEventId,
        meetLink:
          calendarResult.meetLink,
      });

    if (!finalizationResult.ok) {
      await markAdminAttention({
        consultationId:
          consultation.id,
        reason:
          "calendar_created_confirmation_failed",
      });

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          finalizationResult.message,
      };
    }

    return {
      ok: true,
      consultationId:
        consultation.id,
      status:
        finalizationResult.status,
      googleEventId:
        finalizationResult.googleEventId,
      meetLink:
        finalizationResult.meetLink,
    };
  };
