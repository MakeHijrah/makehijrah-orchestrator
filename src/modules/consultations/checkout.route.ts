import type {
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { authenticateRequest } from "../../lib/auth.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import {
  consumeCheckoutCapability,
  validateCheckoutCapability,
} from "./checkout-capability.service.js";
import { createStripeCheckout } from "./checkout.service.js";

const checkoutParamsSchema = z.object({
  id: z.string().uuid(),
});

const checkoutBodySchema = z
  .object({
    checkout_token: z
      .string()
      .trim()
      .min(1)
      .optional(),

    /*
     * The browser's GA4 client id, read from the _ga cookie by
     * the frontend immediately before it sends the visitor to
     * Stripe. It is what lets the server-side `purchase` event
     * join the session and campaign that produced the booking
     * instead of opening a new unattributed one.
     *
     * Optional and analytics-only. A booking must never fail
     * because a cookie was blocked, so anything that does not
     * look like a GA client id is dropped rather than rejected.
     */
    ga_client_id: z
      .string()
      .trim()
      .max(64)
      .regex(/^[0-9]+\.[0-9]+$/)
      .optional()
      .catch(undefined),
  })
  .default({});

type ConsultationOwnerResult =
  | {
      ok: true;
      clientProfileId: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "INTERNAL_ERROR";
      message: string;
    };

const loadConsultationOwner = async (
  consultationId: string,
): Promise<ConsultationOwnerResult> => {
  const {
    data,
    error,
  } = await supabaseAdmin
    .from("consultations")
    .select("client_profile_id")
    .eq("id", consultationId)
    .maybeSingle();

  if (error) {
    console.error(
      "Checkout ownership lookup failed",
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
        "The consultation could not be verified.",
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

  const row = data as unknown as {
    client_profile_id: string;
  };

  return {
    ok: true,
    clientProfileId:
      row.client_profile_id,
  };
};

const authorizeAuthenticatedClient =
  async ({
    request,
    consultationId,
  }: {
    request: FastifyRequest;
    consultationId: string;
  }): Promise<
    | {
        ok: true;
      }
    | {
        ok: false;
        statusCode: 401 | 403 | 404 | 500;
        code:
          | "UNAUTHORIZED"
          | "FORBIDDEN"
          | "NOT_FOUND"
          | "INTERNAL_ERROR";
        message: string;
      }
  > => {
    const authentication =
      await authenticateRequest(request);

    if (!authentication.ok) {
      return authentication;
    }

    if (
      authentication.profile.role !==
      "client"
    ) {
      return {
        ok: false,
        statusCode: 403,
        code: "FORBIDDEN",
        message:
          "You do not have permission to start payment for this consultation.",
      };
    }

    const ownerResult =
      await loadConsultationOwner(
        consultationId,
      );

    if (!ownerResult.ok) {
      return {
        ok: false,
        statusCode:
          ownerResult.code ===
          "NOT_FOUND"
            ? 404
            : 500,
        code: ownerResult.code,
        message: ownerResult.message,
      };
    }

    if (
      ownerResult.clientProfileId !==
      authentication.profile.id
    ) {
      return {
        ok: false,
        statusCode: 404,
        code: "NOT_FOUND",
        message:
          "The consultation was not found.",
      };
    }

    return {
      ok: true,
    };
  };

export const registerCheckoutRoute = async (
  app: FastifyInstance,
): Promise<void> => {
  app.post(
    "/api/consultations/:id/checkout",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsedParams =
        checkoutParamsSchema.safeParse(
          request.params,
        );

      if (!parsedParams.success) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "The consultation ID is invalid.",
          parsedParams.error.flatten(),
        );
      }

      const parsedBody =
        checkoutBodySchema.safeParse(
          request.body ?? {},
        );

      if (!parsedBody.success) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "The checkout request is invalid.",
          parsedBody.error.flatten(),
        );
      }

      const consultationId =
        parsedParams.data.id;

      const checkoutToken =
        parsedBody.data.checkout_token;

      const hasAuthorizationHeader =
        typeof request.headers
          .authorization === "string" &&
        request.headers.authorization
          .trim()
          .length > 0;

      let publicCheckout = false;

      if (hasAuthorizationHeader) {
        const authorizationResult =
          await authorizeAuthenticatedClient({
            request,
            consultationId,
          });

        if (!authorizationResult.ok) {
          return sendError(
            reply,
            authorizationResult.statusCode,
            authorizationResult.code,
            authorizationResult.message,
          );
        }
      } else {
        if (!checkoutToken) {
          return sendError(
            reply,
            401,
            "UNAUTHORIZED",
            "A valid checkout token is required.",
          );
        }

        const capabilityValidation =
          await validateCheckoutCapability({
            consultationId,
            token: checkoutToken,
          });

        if (!capabilityValidation.ok) {
          return sendError(
            reply,
            capabilityValidation.code ===
              "CHECKOUT_TOKEN_INVALID"
              ? 401
              : 500,
            capabilityValidation.code,
            capabilityValidation.message,
          );
        }

        publicCheckout = true;
      }

      const checkoutResult =
        await createStripeCheckout(
          consultationId,
          parsedBody.data.ga_client_id ?? null,
        );

      if (!checkoutResult.ok) {
        switch (checkoutResult.code) {
          case "NOT_FOUND":
            return sendError(
              reply,
              404,
              "NOT_FOUND",
              checkoutResult.message,
            );

          case "DRAFT_EXPIRED":
            return sendError(
              reply,
              409,
              "DRAFT_EXPIRED",
              checkoutResult.message,
            );

          case "INVALID_TRANSITION":
            return sendError(
              reply,
              409,
              "INVALID_TRANSITION",
              checkoutResult.message,
            );

          case "STRIPE_ERROR":
            return sendError(
              reply,
              502,
              "STRIPE_ERROR",
              checkoutResult.message,
            );

          case "INTERNAL_ERROR":
          default:
            return sendError(
              reply,
              500,
              "INTERNAL_ERROR",
              "The payment session could not be created.",
            );
        }
      }

      if (
        publicCheckout &&
        checkoutToken
      ) {
        const consumeResult =
          await consumeCheckoutCapability({
            consultationId,
            token: checkoutToken,
          });

        if (!consumeResult.ok) {
          request.log.error(
            {
              consultationId,
              code: consumeResult.code,
            },
            "Checkout capability consumption failed after Stripe session creation",
          );

          return sendError(
            reply,
            consumeResult.code ===
              "CHECKOUT_TOKEN_INVALID"
              ? 401
              : 500,
            consumeResult.code,
            consumeResult.message,
          );
        }
      }

      return sendSuccess(reply, {
        checkout_url:
          checkoutResult.checkoutUrl,
      });
    },
  );
};
