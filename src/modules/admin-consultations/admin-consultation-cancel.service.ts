import type Stripe from "stripe";
import { stripe } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import {
  deleteConsultationCalendarEvent,
} from "../consultations/google-calendar-event.service.js";

type AdminCancellationRow = {
  id: string;
  consultant_id: string;
  status: string;
  stripe_payment_intent_id: string | null;
  google_event_id: string | null;
  cancelled_at: string | null;
  admin_attention_reason: string | null;
};

export type AdminCancelConsultationResult =
  | {
      ok: true;
      consultationId: string;
      status: string;
      cancelledAt: string | null;
      adminAttentionReason: string | null;
      refunded: boolean;
      stripeAction:
        | "none"
        | "authorization_cancelled"
        | "refunded";
      calendarAction:
        | "none"
        | "deleted"
        | "already_deleted";
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "INVALID_TRANSITION"
        | "PAYMENT_NOT_AVAILABLE"
        | "STRIPE_ERROR"
        | "GOOGLE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const loadConsultation = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      consultation: AdminCancellationRow;
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
        "id, consultant_id, status, stripe_payment_intent_id, google_event_id, cancelled_at, admin_attention_reason",
      )
      .eq("id", consultationId)
      .maybeSingle();

  if (error) {
    console.error(
      "Admin consultation lookup failed",
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
      data as unknown as AdminCancellationRow,
  };
};

const cancelAuthorization = async (
  paymentIntentId: string,
): Promise<
  | {
      ok: true;
      action:
        | "none"
        | "authorization_cancelled";
    }
  | {
      ok: false;
      code:
        | "PAYMENT_NOT_AVAILABLE"
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
      "Stripe PaymentIntent retrieval failed during admin cancellation",
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
        "The payment could not be verified.",
    };
  }

  if (paymentIntent.status === "canceled") {
    return {
      ok: true,
      action: "none",
    };
  }

  if (paymentIntent.status !== "requires_capture") {
    return {
      ok: false,
      code: "PAYMENT_NOT_AVAILABLE",
      message:
        "The payment authorization cannot be cancelled from its current state.",
    };
  }

  try {
    await stripe.paymentIntents.cancel(
      paymentIntentId,
      {
        cancellation_reason:
          "requested_by_customer",
      },
      {
        idempotencyKey:
          `admin-consultation-cancel-${paymentIntentId}`,
      },
    );

    return {
      ok: true,
      action:
        "authorization_cancelled",
    };
  } catch (error) {
    console.error(
      "Stripe authorization cancellation failed during admin cancellation",
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
        "The payment authorization could not be cancelled.",
    };
  }
};

const refundPayment = async (
  paymentIntentId: string,
): Promise<
  | {
      ok: true;
      action: "refunded";
    }
  | {
      ok: false;
      code:
        | "PAYMENT_NOT_AVAILABLE"
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
      "Stripe PaymentIntent retrieval failed during admin refund",
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
        "The captured payment could not be verified.",
    };
  }

  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.amount_received <= 0
  ) {
    return {
      ok: false,
      code: "PAYMENT_NOT_AVAILABLE",
      message:
        "This consultation has no captured payment available to refund.",
    };
  }

  try {
    await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason: "requested_by_customer",
        metadata: {
          consultation_action:
            "admin_cancel",
        },
      },
      {
        idempotencyKey:
          `admin-consultation-refund-${paymentIntentId}`,
      },
    );

    return {
      ok: true,
      action: "refunded",
    };
  } catch (error) {
    console.error(
      "Stripe refund failed during admin cancellation",
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
        "The captured payment could not be refunded.",
    };
  }
};

const removeCalendarEvent = async ({
  consultantId,
  googleEventId,
}: {
  consultantId: string;
  googleEventId: string | null;
}): Promise<
  | {
      ok: true;
      action:
        | "none"
        | "deleted"
        | "already_deleted";
    }
  | {
      ok: false;
      code: "GOOGLE_ERROR";
      message: string;
    }
> => {
  const eventId =
    googleEventId?.trim();

  if (!eventId) {
    return {
      ok: true,
      action: "none",
    };
  }

  const result =
    await deleteConsultationCalendarEvent({
      consultantId,
      googleEventId: eventId,
    });

  if (!result.ok) {
    console.error(
      "Admin cancellation could not remove Google Calendar event",
      {
        consultantId,
        googleEventId: eventId,
        code: result.code,
        message: result.message,
      },
    );

    return {
      ok: false,
      code: "GOOGLE_ERROR",
      message:
        "The consultant calendar event could not be removed.",
    };
  }

  return {
    ok: true,
    action:
      result.alreadyDeleted
        ? "already_deleted"
        : "deleted",
  };
};

const finalizeCancellation = async ({
  consultationId,
  refund,
  note,
}: {
  consultationId: string;
  refund: boolean;
  note: string | null;
}): Promise<
  | {
      ok: true;
      status: string;
      cancelledAt: string | null;
      adminAttentionReason: string | null;
    }
  | {
      ok: false;
      code:
        | "INVALID_TRANSITION"
        | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin.rpc(
      "finalize_admin_consultation_cancel",
      {
        p_consultation_id:
          consultationId,
        p_refund:
          refund,
        p_note:
          note,
      },
    );

  if (error) {
    const message =
      error.message ?? "";

    if (
      message.includes(
        "INVALID_REFUND_TRANSITION",
      ) ||
      message.includes(
        "INVALID_CANCEL_TRANSITION",
      )
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The consultation cannot be cancelled from its current state.",
      };
    }

    console.error(
      "Admin consultation cancellation RPC failed",
      {
        consultationId,
        refund,
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
        "The consultation cancellation could not be finalized.",
    };
  }

  const row =
    (
      data as unknown as
        | Array<{
            consultation_id: string;
            consultation_status: string;
            cancelled_at: string | null;
            admin_attention_reason: string | null;
          }>
        | null
    )?.[0];

  if (!row) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation cancellation returned no result.",
    };
  }

  return {
    ok: true,
    status:
      row.consultation_status,
    cancelledAt:
      row.cancelled_at,
    adminAttentionReason:
      row.admin_attention_reason,
  };
};

const AUTHORIZATION_STATUSES =
  new Set([
    "payment_authorized",
    "pending_acceptance",
  ]);

const CAPTURED_STATUSES =
  new Set([
    "confirmed",
    "captured",
    "completed",
  ]);

export const adminCancelConsultation =
  async ({
    consultationId,
    refund,
    note,
  }: {
    consultationId: string;
    refund: boolean;
    note: string | null;
  }): Promise<AdminCancelConsultationResult> => {
    const loaded =
      await loadConsultation(
        consultationId,
      );

    if (!loaded.ok) {
      return loaded;
    }

    const { consultation } =
      loaded;

    if (
      consultation.status === "refunded"
    ) {
      return {
        ok: true,
        consultationId:
          consultation.id,
        status:
          consultation.status,
        cancelledAt:
          consultation.cancelled_at,
        adminAttentionReason:
          consultation.admin_attention_reason,
        refunded: true,
        stripeAction: "none",
        calendarAction: "none",
      };
    }

    if (
      consultation.status === "cancelled" &&
      !refund
    ) {
      return {
        ok: true,
        consultationId:
          consultation.id,
        status:
          consultation.status,
        cancelledAt:
          consultation.cancelled_at,
        adminAttentionReason:
          consultation.admin_attention_reason,
        refunded: false,
        stripeAction: "none",
        calendarAction: "none",
      };
    }

    const paymentIntentId =
      consultation
        .stripe_payment_intent_id
        ?.trim() || null;

    let stripeAction:
      | "none"
      | "authorization_cancelled"
      | "refunded" = "none";

    if (
      refund &&
      !CAPTURED_STATUSES.has(
        consultation.status,
      ) &&
      consultation.status !==
        "admin_attention" &&
      consultation.status !==
        "cancelled"
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "This consultation is not eligible for a refund.",
      };
    }

    const calendarResult =
      await removeCalendarEvent({
        consultantId:
          consultation.consultant_id,
        googleEventId:
          consultation.google_event_id,
      });

    if (!calendarResult.ok) {
      return calendarResult;
    }

    if (refund) {
      if (!paymentIntentId) {
        return {
          ok: false,
          code: "PAYMENT_NOT_AVAILABLE",
          message:
            "This consultation has no payment available to refund.",
        };
      }

      const refundResult =
        await refundPayment(
          paymentIntentId,
        );

      if (!refundResult.ok) {
        return refundResult;
      }

      stripeAction =
        refundResult.action;
    } else if (
      AUTHORIZATION_STATUSES.has(
        consultation.status,
      )
    ) {
      if (!paymentIntentId) {
        return {
          ok: false,
          code: "PAYMENT_NOT_AVAILABLE",
          message:
            "This consultation has no payment authorization to cancel.",
        };
      }

      const cancelResult =
        await cancelAuthorization(
          paymentIntentId,
        );

      if (!cancelResult.ok) {
        return cancelResult;
      }

      stripeAction =
        cancelResult.action;
    } else if (
      consultation.status ===
        "admin_attention" &&
      paymentIntentId
    ) {
      /*
       * Decline and timeout may already have cancelled the authorization.
       * Calendar-failure attention may hold captured money.
       * Only attempt cancellation when Stripe still reports requires_capture.
       */
      let paymentIntent:
        Stripe.PaymentIntent;

      try {
        paymentIntent =
          await stripe.paymentIntents.retrieve(
            paymentIntentId,
          );
      } catch (error) {
        console.error(
          "Stripe PaymentIntent retrieval failed for admin-attention cancellation",
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
            "The payment state could not be verified.",
        };
      }

      if (
        paymentIntent.status ===
          "requires_capture"
      ) {
        const cancelResult =
          await cancelAuthorization(
            paymentIntentId,
          );

        if (!cancelResult.ok) {
          return cancelResult;
        }

        stripeAction =
          cancelResult.action;
      }
    }

    const finalized =
      await finalizeCancellation({
        consultationId:
          consultation.id,
        refund,
        note,
      });

    if (!finalized.ok) {
      return finalized;
    }

    return {
      ok: true,
      consultationId:
        consultation.id,
      status:
        finalized.status,
      cancelledAt:
        finalized.cancelledAt,
      adminAttentionReason:
        finalized.adminAttentionReason,
      refunded:
        finalized.status === "refunded",
      stripeAction,
      calendarAction:
        calendarResult.action,
    };
  };
