import type { FastifyInstance } from "fastify";
import { sendError, sendSuccess } from "../../lib/api-response.js";
import { availabilityQuerySchema } from "./availability.schema.js";
import { getConsultantForAvailability } from "./availability.service.js";

export const registerAvailabilityRoute = async (
  app: FastifyInstance,
): Promise<void> => {
  app.get("/api/availability", async (request, reply) => {
    const parsed = availabilityQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "The availability request is invalid.",
        parsed.error.flatten(),
      );
    }

    const consultantResult = await getConsultantForAvailability(
      parsed.data.consultant_id,
    );

    if (!consultantResult.ok) {
      if (consultantResult.code === "NOT_FOUND") {
        return sendError(
          reply,
          404,
          "CONSULTANT_NOT_FOUND",
          consultantResult.message,
        );
      }

      if (consultantResult.code === "OAUTH_NOT_CONNECTED") {
        return sendError(
          reply,
          409,
          "OAUTH_NOT_CONNECTED",
          consultantResult.message,
        );
      }

      return sendError(
        reply,
        500,
        "INTERNAL_ERROR",
        consultantResult.message,
      );
    }

    return sendSuccess(reply, {
      consultant_id: consultantResult.consultant.id,
      timezone: consultantResult.consultant.timezone,
      from: parsed.data.from,
      to: parsed.data.to,
      slots: [],
      status: "calculation_pending",
    });
  });
};
