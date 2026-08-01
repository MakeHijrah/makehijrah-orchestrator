import type Stripe from "stripe";
import {
  paymentIntentModeMatches,
  resolveConsultationStripeClient,
} from "./consultation-stripe-mode.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import {
  scheduleAuthorizationTimeoutNotification,
} from "./authorization-timeout-notification.service.js";

const AUTHORIZATION_TIMEOUT_HOURS = 48;

type TimeoutConsultationRow = {
  id: string;
  status: string;
  stripe_payment_intent_id: string | null;
  stripe_mode: string | null;
  payment_authorized_at: string | null;
  cancelled_at: string | null;
  admin_attention_reason: string | null;
};

export type AuthorizationTimeoutCandidateResult =
  | {
      ok: true;
      consultationIds: string[];
    }
  | {
      ok: false;
      message: string;
    };

export type ProcessAuthorizationTimeoutResult =
  | {
      ok: true;
      consultationId: string;
      outcome:
        | "timed_out"
        | "already_timed_out"
        | "not_due"
        | "no_longer_eligible";
      status: string;
      cancelledAt: string | null;
      adminAttentionReason: string | null;
    }
  | {
      ok: false;
      consultationId: string;
      action: "retry" | "remove";
      code:
        | "NOT_FOUND"
        | "PAYMENT_NOT_AUTHORIZED"
        | "STRIPE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const timeoutCutoffIso = (): string =>
  new Date(
    Date.now() -
      AUTHORIZATION_TIMEOUT_HOURS *
        60 *
        60 *
        1000,
  ).toISOString();

export const listAuthorizationTimeoutCandidates =
  async (
    limit = 25,
  ): Promise<AuthorizationTimeoutCandidateResult> => {
    const safeLimit =
      Math.max(
        1,
        Math.min(
          limit,
          100,
        ),
      );

    const { data, error } =
      await supabaseAdmin
        .from("consultations")
        .select("id")
        .in("status", [
          "pending_acceptance",
          "authorization_cancelled",
        ])
        .not(
          "payment_authorized_at",
          "is",
          null,
        )
        .lte(
          "payment_authorized_at",
          timeoutCutoffIso(),
        )
        .order(
          "payment_authorized_at",
          {
            ascending: true,
          },
        )
        .limit(
          safeLimit,
        );

    if (error) {
      console.error(
        "Authorization timeout candidate lookup failed",
        {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
        message:
          "Authorization timeout candidates could not be loaded.",
      };
    }

    const consultationIds =
      (
        (data ?? []) as Array<{
          id: string;
        }>
      )
        .map(
          (row) =>
            row.id,
        )
        .filter(
          (id) =>
            typeof id ===
              "string" &&
            id.length > 0,
        );

    return {
      ok: true,
      consultationIds,
    };
  };

const loadTimeoutConsultation =
  async (
    consultationId: string,
  ): Promise<
    | {
        ok: true;
        consultation:
          TimeoutConsultationRow;
      }
    | {
        ok: false;
        code:
          | "NOT_FOUND"
          | "INTERNAL_ERROR";
        message: string;
      }
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultations")
        .select(
          [
            "id",
            "status",
            "stripe_payment_intent_id",
            "stripe_mode",
            "payment_authorized_at",
            "cancelled_at",
            "admin_attention_reason",
          ].join(", "),
        )
        .eq(
          "id",
          consultationId,
        )
        .maybeSingle();

    if (error) {
      console.error(
        "Authorization timeout consultation lookup failed",
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
          "The consultation could not be loaded for timeout processing.",
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
        data as unknown as TimeoutConsultationRow,
    };
  };

const authorizationHasExpired = (
  paymentAuthorizedAt: string,
): boolean => {
  const timestamp =
    Date.parse(
      paymentAuthorizedAt,
    );

  if (
    Number.isNaN(
      timestamp,
    )
  ) {
    return false;
  }

  return (
    timestamp <=
    Date.now() -
      AUTHORIZATION_TIMEOUT_HOURS *
        60 *
        60 *
        1000
  );
};

const cancelPaymentAuthorization =
  async (
    paymentIntentId: string,
    stripe: Stripe,
    mode: "test" | "live",
  ): Promise<
    | {
        ok: true;
        paymentIntent:
          Stripe.PaymentIntent;
      }
    | {
        ok: false;
        code:
          | "PAYMENT_NOT_AUTHORIZED"
          | "STRIPE_ERROR";
        action:
          | "retry"
          | "remove";
        message: string;
      }
  > => {
    let paymentIntent:
      Stripe.PaymentIntent;

    try {
      paymentIntent =
        await stripe.paymentIntents.retrieve(
          paymentIntentId,
        );
    } catch (error) {
      console.error(
        "Stripe PaymentIntent retrieval failed during authorization timeout",
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
        action: "retry",
        message:
          "The payment authorization could not be verified.",
      };
    }

    if (
      !paymentIntentModeMatches({
        paymentIntent,
        mode,
      })
    ) {
      console.error(
        "Stripe livemode mismatch blocked a timeout cancellation",
        {
          paymentIntentId,
          expectedMode: mode,
        },
      );

      return {
        ok: false,
        code: "STRIPE_ERROR",
        action: "remove",
        message:
          "The payment could not be verified against its original Stripe account.",
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
      console.warn(
        "Authorization timeout skipped because the PaymentIntent is no longer cancellable",
        {
          paymentIntentId,
          paymentIntentStatus:
            paymentIntent.status,
        },
      );

      return {
        ok: false,
        code:
          "PAYMENT_NOT_AUTHORIZED",
        action: "remove",
        message:
          "The payment authorization is no longer cancellable.",
      };
    }

    try {
      const cancelledPaymentIntent =
        await stripe.paymentIntents.cancel(
          paymentIntentId,
          {
            cancellation_reason:
              "abandoned",
          },
          {
            idempotencyKey:
              `consultation-timeout-${paymentIntentId}`,
          },
        );

      return {
        ok: true,
        paymentIntent:
          cancelledPaymentIntent,
      };
    } catch (error) {
      console.error(
        "Stripe PaymentIntent cancellation failed during authorization timeout",
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
        action: "retry",
        message:
          "The payment authorization could not be cancelled.",
      };
    }
  };

const finalizeAuthorizationTimeout =
  async (
    consultationId: string,
  ): Promise<
    | {
        ok: true;
        status: string;
        cancelledAt: string;
        adminAttentionReason: string;
      }
    | {
        ok: false;
        message: string;
      }
  > => {
    const { data, error } =
      await supabaseAdmin.rpc(
        "finalize_authorization_timeout",
        {
          p_consultation_id:
            consultationId,
        },
      );

    if (error) {
      console.error(
        "Authorization timeout RPC failed",
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
        message:
          "The authorization timeout could not be finalized.",
      };
    }

    const row =
      (
        data as unknown as
          | Array<{
              consultation_id: string;
              consultation_status: string;
              cancelled_at: string;
              admin_attention_reason: string;
            }>
          | null
      )?.[0];

    if (
      !row ||
      !row.cancelled_at ||
      row.admin_attention_reason !==
        "timeout"
    ) {
      console.error(
        "Authorization timeout RPC returned an invalid result",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        message:
          "The authorization timeout returned no valid result.",
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

const scheduleNotificationBestEffort =
  async (
    consultationId: string,
  ): Promise<void> => {
    const result =
      await scheduleAuthorizationTimeoutNotification({
        consultationId,
      });

    if (!result.ok) {
      console.error(
        "Authorization timeout succeeded but notification scheduling failed",
        {
          consultationId,
          message: result.message,
        },
      );
    }
  };

export const processAuthorizationTimeout =
  async (
    consultationId: string,
  ): Promise<ProcessAuthorizationTimeoutResult> => {
    const loadResult =
      await loadTimeoutConsultation(
        consultationId,
      );

    if (!loadResult.ok) {
      return {
        ok: false,
        consultationId,
        action:
          loadResult.code ===
          "NOT_FOUND"
            ? "remove"
            : "retry",
        code:
          loadResult.code,
        message:
          loadResult.message,
      };
    }

    const { consultation } =
      loadResult;

    if (
      consultation.status ===
        "admin_attention" &&
      consultation
        .admin_attention_reason ===
        "timeout" &&
      consultation.cancelled_at
    ) {
      await scheduleNotificationBestEffort(
        consultationId,
      );

      return {
        ok: true,
        consultationId,
        outcome:
          "already_timed_out",
        status:
          consultation.status,
        cancelledAt:
          consultation.cancelled_at,
        adminAttentionReason:
          consultation
            .admin_attention_reason,
      };
    }

    if (
      consultation.status !==
        "pending_acceptance" &&
      consultation.status !==
        "authorization_cancelled"
    ) {
      return {
        ok: true,
        consultationId,
        outcome:
          "no_longer_eligible",
        status:
          consultation.status,
        cancelledAt:
          consultation.cancelled_at,
        adminAttentionReason:
          consultation
            .admin_attention_reason,
      };
    }

    const paymentAuthorizedAt =
      consultation
        .payment_authorized_at
        ?.trim();

    if (
      !paymentAuthorizedAt
    ) {
      console.error(
        "Authorization timeout consultation has no authorization timestamp",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        consultationId,
        action: "remove",
        code:
          "PAYMENT_NOT_AUTHORIZED",
        message:
          "The consultation has no payment authorization timestamp.",
      };
    }

    if (
      !authorizationHasExpired(
        paymentAuthorizedAt,
      )
    ) {
      return {
        ok: true,
        consultationId,
        outcome: "not_due",
        status:
          consultation.status,
        cancelledAt:
          consultation.cancelled_at,
        adminAttentionReason:
          consultation
            .admin_attention_reason,
      };
    }

    const paymentIntentId =
      consultation
        .stripe_payment_intent_id
        ?.trim();

    if (!paymentIntentId) {
      console.error(
        "Authorization timeout consultation has no PaymentIntent",
        {
          consultationId,
        },
      );

      return {
        ok: false,
        consultationId,
        action: "remove",
        code:
          "PAYMENT_NOT_AUTHORIZED",
        message:
          "The consultation has no Stripe PaymentIntent.",
      };
    }

    const stripeClientResult =
      resolveConsultationStripeClient(
        consultation,
      );

    if (!stripeClientResult.ok) {
      return {
        ok: false,
        consultationId,
        action: "remove",
        code: "STRIPE_ERROR",
        message:
          stripeClientResult.message,
      };
    }

    const cancellationResult =
      await cancelPaymentAuthorization(
        paymentIntentId,
        stripeClientResult.client,
        stripeClientResult.mode,
      );

    if (!cancellationResult.ok) {
      return {
        ok: false,
        consultationId,
        action:
          cancellationResult.action,
        code:
          cancellationResult.code,
        message:
          cancellationResult.message,
      };
    }

    const finalizationResult =
      await finalizeAuthorizationTimeout(
        consultationId,
      );

    if (!finalizationResult.ok) {
      return {
        ok: false,
        consultationId,
        action: "retry",
        code:
          "INTERNAL_ERROR",
        message:
          finalizationResult.message,
      };
    }

    await scheduleNotificationBestEffort(
      consultationId,
    );

    return {
      ok: true,
      consultationId,
      outcome: "timed_out",
      status:
        finalizationResult.status,
      cancelledAt:
        finalizationResult.cancelledAt,
      adminAttentionReason:
        finalizationResult
          .adminAttentionReason,
    };
  };