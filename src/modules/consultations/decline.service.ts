import type Stripe from "stripe";
import { stripe } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";

type DeclineConsultationRow = {
  id: string;
  consultant_id: string;
  status: string;
  stripe_payment_intent_id: string | null;
  declined_at: string | null;
  admin_attention_reason: string | null;
};

export type DeclineConsultationResult =
  | {
      ok: true;
      consultationId: string;
      status: string;
      declinedAt: string;
      adminAttentionReason: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INVALID_TRANSITION"
        | "PAYMENT_NOT_AUTHORIZED"
        | "STRIPE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const loadDeclineConsultation = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      consultation: DeclineConsultationRow;
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
        "id, consultant_id, status, stripe_payment_intent_id, declined_at, admin_attention_reason",
      )
      .eq("id", consultationId)
      .maybeSingle();

  if (error) {
    console.error(
      "Decline consultation lookup failed",
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
      data as unknown as DeclineConsultationRow,
  };
};

const cancelPaymentAuthorization = async (
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
      "Stripe PaymentIntent retrieval failed during decline",
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
    "canceled"
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
        "The payment authorization cannot be cancelled from its current state.",
    };
  }

  try {
    const cancelledPaymentIntent =
      await stripe.paymentIntents.cancel(
        paymentIntentId,
        {
          cancellation_reason:
            "requested_by_customer",
        },
        {
          idempotencyKey:
            `consultation-decline-${paymentIntentId}`,
        },
      );

    return {
      ok: true,
      paymentIntent:
        cancelledPaymentIntent,
    };
  } catch (error) {
    console.error(
      "Stripe PaymentIntent cancellation failed during decline",
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

const finalizeDecline = async ({
  consultationId,
  consultantId,
  declineReason,
}: {
  consultationId: string;
  consultantId: string;
  declineReason: string | null;
}): Promise<
  | {
      ok: true;
      status: string;
      declinedAt: string;
      adminAttentionReason: string;
    }
  | {
      ok: false;
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin.rpc(
      "finalize_consultation_decline",
      {
        p_consultation_id:
          consultationId,
        p_consultant_id:
          consultantId,
        p_decline_reason:
          declineReason,
      },
    );

  if (error) {
    console.error(
      "Consultation decline RPC failed",
      {
        consultationId,
        consultantId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      message:
        "The consultation decline could not be finalized.",
    };
  }

  const row =
    (
      data as unknown as
        | Array<{
            consultation_id: string;
            consultation_status: string;
            declined_at: string;
            admin_attention_reason: string;
          }>
        | null
    )?.[0];

  if (
    !row ||
    !row.declined_at ||
    !row.admin_attention_reason
  ) {
    return {
      ok: false,
      message:
        "The consultation decline returned no result.",
    };
  }

  return {
    ok: true,
    status:
      row.consultation_status,
    declinedAt:
      row.declined_at,
    adminAttentionReason:
      row.admin_attention_reason,
  };
};

export const declineConsultation =
  async ({
    consultationId,
    consultantId,
    declineReason,
  }: {
    consultationId: string;
    consultantId: string;
    declineReason: string | null;
  }): Promise<DeclineConsultationResult> => {
    const consultationResult =
      await loadDeclineConsultation(
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
          "You do not have permission to decline this consultation.",
      };
    }

    if (
      consultation.status ===
        "admin_attention" &&
      consultation.admin_attention_reason ===
        "declined" &&
      consultation.declined_at
    ) {
      return {
        ok: true,
        consultationId:
          consultation.id,
        status:
          consultation.status,
        declinedAt:
          consultation.declined_at,
        adminAttentionReason:
          consultation.admin_attention_reason,
      };
    }

    if (
      consultation.status !==
        "pending_acceptance" &&
      consultation.status !==
        "authorization_cancelled"
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The consultation cannot be declined from its current status.",
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

    const cancellationResult =
      await cancelPaymentAuthorization(
        paymentIntentId,
      );

    if (!cancellationResult.ok) {
      return cancellationResult;
    }

    const finalizationResult =
      await finalizeDecline({
        consultationId:
          consultation.id,
        consultantId,
        declineReason,
      });

    if (!finalizationResult.ok) {
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
      declinedAt:
        finalizationResult.declinedAt,
      adminAttentionReason:
        finalizationResult.adminAttentionReason,
    };
  };
