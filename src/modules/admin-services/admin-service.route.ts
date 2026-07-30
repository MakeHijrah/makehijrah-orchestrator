/*
 * The five admin service endpoints authorised by PROJECT_LOCK
 * Amendment 004 section 14.1. No other service-mutation endpoint
 * is permitted (section 14.2).
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import {
  requireRole,
  type AuthenticationResult,
} from "../../lib/auth.js";
import {
  createServiceBodySchema,
  deleteServiceQuerySchema,
  findServerOwnedKeys,
  idempotencyKeySchema,
  patchServiceBodySchema,
  serviceParamsSchema,
} from "./admin-service.schema.js";
import {
  activateService,
  createService,
  deactivateService,
  removeService,
  updateService,
  type AdminServiceDeleteResult,
  type AdminServiceErrorCode,
  type AdminServiceFailure,
  type AdminServiceResult,
} from "./admin-service.service.js";

/*
 * API_CONTRACT.md section 0 fixes the error-code vocabulary.
 * requireRole predates that contract and returns UNAUTHORIZED and
 * INTERNAL_ERROR, neither of which is in it, so this module
 * translates rather than forwarding the auth result verbatim.
 *
 * The older modules still emit the legacy spellings. Aligning
 * them is a separate change; this module follows the documented
 * contract.
 */
const translateAuthenticationFailure = (
  authentication: Extract<
    AuthenticationResult,
    { ok: false }
  >,
): {
  statusCode: 401 | 403 | 500;
  code: AdminServiceErrorCode | "UNAUTHENTICATED" | "FORBIDDEN";
  message: string;
} => {
  if (
    authentication.code ===
    "UNAUTHORIZED"
  ) {
    return {
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: authentication.message,
    };
  }

  if (
    authentication.code === "FORBIDDEN"
  ) {
    return {
      statusCode: 403,
      code: "FORBIDDEN",
      message: authentication.message,
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL",
    message: authentication.message,
  };
};

const statusForCode = (
  code: AdminServiceErrorCode,
): number => {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;

    case "NOT_FOUND":
      return 404;

    case "INVALID_TRANSITION":
      return 409;

    case "STRIPE_ERROR":
      return 502;

    case "INTERNAL":
    default:
      return 500;
  }
};

const sendFailure = (
  reply: FastifyReply,
  failure: AdminServiceFailure,
): FastifyReply => {
  return sendError(
    reply,
    statusForCode(failure.code),
    failure.code,
    failure.message,
    failure.details,
  );
};

const sendServiceResult = (
  reply: FastifyReply,
  result: AdminServiceResult,
): FastifyReply => {
  if (!result.ok) {
    return sendFailure(reply, result);
  }

  return sendSuccess(reply, {
    service: result.service,
  });
};

/*
 * Returns the authenticated admin profile, or null after the
 * failure has already been sent.
 */
const authenticateAdmin = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<
  | {
      adminProfileId: string;
    }
  | null
> => {
  const authentication =
    await requireRole(request, [
      "admin",
    ]);

  if (!authentication.ok) {
    const translated =
      translateAuthenticationFailure(
        authentication,
      );

    sendError(
      reply,
      translated.statusCode,
      translated.code,
      translated.message,
    );

    return null;
  }

  return {
    adminProfileId:
      authentication.profile.id,
  };
};

const parseServiceId = (
  request: FastifyRequest,
  reply: FastifyReply,
): string | null => {
  const parsed =
    serviceParamsSchema.safeParse(
      request.params,
    );

  if (!parsed.success) {
    sendError(
      reply,
      400,
      "VALIDATION_ERROR",
      "The service ID is invalid.",
      parsed.error.flatten(),
    );

    return null;
  }

  return parsed.data.id;
};

/*
 * Section 14.3.10: no Stripe identifier and no price display is
 * accepted from a client. The strict schemas would already reject
 * these as unknown keys; checking them by name first turns a
 * generic rejection into an explicit one.
 */
const rejectServerOwnedKeys = (
  request: FastifyRequest,
  reply: FastifyReply,
): boolean => {
  const forbidden =
    findServerOwnedKeys(request.body);

  if (forbidden.length === 0) {
    return false;
  }

  sendError(
    reply,
    400,
    "VALIDATION_ERROR",
    "These fields are managed by the orchestrator and cannot be submitted.",
    { forbidden_keys: forbidden },
  );

  return true;
};

const readIdempotencyKey = (
  request: FastifyRequest,
  reply: FastifyReply,
): string | null => {
  const header =
    request.headers[
      "idempotency-key"
    ];

  if (header === undefined) {
    sendError(
      reply,
      400,
      "VALIDATION_ERROR",
      "An Idempotency-Key header is required.",
      {
        reason:
          "idempotency_key_required",
      },
    );

    return null;
  }

  /*
   * A repeated header arrives as an array. There is no safe way
   * to choose between two values, so it is rejected.
   */
  if (typeof header !== "string") {
    sendError(
      reply,
      400,
      "VALIDATION_ERROR",
      "The Idempotency-Key header must be sent exactly once.",
      {
        reason:
          "idempotency_key_invalid",
      },
    );

    return null;
  }

  const parsed =
    idempotencyKeySchema.safeParse(
      header,
    );

  if (!parsed.success) {
    sendError(
      reply,
      400,
      "VALIDATION_ERROR",
      "The Idempotency-Key header must be between 16 and 128 characters.",
      {
        reason:
          "idempotency_key_invalid",
      },
    );

    return null;
  }

  return parsed.data;
};

export const registerAdminServiceRoutes =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/admin/services",
      async (request, reply) => {
        const admin =
          await authenticateAdmin(
            request,
            reply,
          );

        if (!admin) {
          return reply;
        }

        if (
          rejectServerOwnedKeys(
            request,
            reply,
          )
        ) {
          return reply;
        }

        /*
         * The body is validated before the idempotency key is
         * claimed, so a malformed request never consumes a key.
         */
        const parsedBody =
          createServiceBodySchema.safeParse(
            request.body,
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The service could not be created from the supplied values.",
            parsedBody.error.flatten(),
          );
        }

        const idempotencyKey =
          readIdempotencyKey(
            request,
            reply,
          );

        if (!idempotencyKey) {
          return reply;
        }

        const result =
          await createService({
            adminProfileId:
              admin.adminProfileId,
            idempotencyKey,
            body: parsedBody.data,
          });

        return sendServiceResult(
          reply,
          result,
        );
      },
    );

    app.patch(
      "/api/admin/services/:id",
      async (request, reply) => {
        const admin =
          await authenticateAdmin(
            request,
            reply,
          );

        if (!admin) {
          return reply;
        }

        const serviceId =
          parseServiceId(
            request,
            reply,
          );

        if (!serviceId) {
          return reply;
        }

        if (
          rejectServerOwnedKeys(
            request,
            reply,
          )
        ) {
          return reply;
        }

        const parsedBody =
          patchServiceBodySchema.safeParse(
            request.body,
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The service could not be updated from the supplied values.",
            parsedBody.error.flatten(),
          );
        }

        const result =
          await updateService({
            serviceId,
            rawBody: request.body,
            body: parsedBody.data,
          });

        return sendServiceResult(
          reply,
          result,
        );
      },
    );

    app.post(
      "/api/admin/services/:id/activate",
      async (request, reply) => {
        const admin =
          await authenticateAdmin(
            request,
            reply,
          );

        if (!admin) {
          return reply;
        }

        const serviceId =
          parseServiceId(
            request,
            reply,
          );

        if (!serviceId) {
          return reply;
        }

        const result =
          await activateService(
            serviceId,
          );

        return sendServiceResult(
          reply,
          result,
        );
      },
    );

    app.post(
      "/api/admin/services/:id/deactivate",
      async (request, reply) => {
        const admin =
          await authenticateAdmin(
            request,
            reply,
          );

        if (!admin) {
          return reply;
        }

        const serviceId =
          parseServiceId(
            request,
            reply,
          );

        if (!serviceId) {
          return reply;
        }

        const result =
          await deactivateService(
            serviceId,
          );

        return sendServiceResult(
          reply,
          result,
        );
      },
    );

    app.delete(
      "/api/admin/services/:id",
      async (request, reply) => {
        const admin =
          await authenticateAdmin(
            request,
            reply,
          );

        if (!admin) {
          return reply;
        }

        const serviceId =
          parseServiceId(
            request,
            reply,
          );

        if (!serviceId) {
          return reply;
        }

        /*
         * Section 13.6 requires explicit administrator
         * confirmation. It is validated here, before the
         * reference counts, before any Stripe call and before any
         * database mutation. It is never inferred from the HTTP
         * method or from UI state.
         */
        const parsedQuery =
          deleteServiceQuerySchema.safeParse(
            request.query,
          );

        if (!parsedQuery.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "Deleting a service requires explicit confirmation with confirm=true.",
            {
              reason:
                "confirmation_required",
            },
          );
        }

        const result: AdminServiceDeleteResult =
          await removeService(
            serviceId,
          );

        if (!result.ok) {
          return sendFailure(
            reply,
            result,
          );
        }

        return sendSuccess(reply, {
          deleted: true,
          id: result.id,
        });
      },
    );
  };
