import {
  getCachedAvailability,
  setCachedAvailability,
} from "./availability.cache.js";
import { calculateLocalAvailability } from "./availability.local.js";
import type { AvailabilityResult } from "./availability.types.js";

type CalculateAvailabilityInput = {
  consultantId: string;
  timezone: string;
  workingHours: Record<string, unknown>;
  minimumBookingNoticeHours: number;
  from: string;
  to: string;
};

export type AvailabilityCalculationResult =
  | {
      ok: true;
      data: AvailabilityResult;
      source: "cache" | "calculated";
    }
  | {
      ok: false;
      code: "GOOGLE_ERROR" | "INTERNAL_ERROR";
      message: string;
    };

export const calculateAvailability = async ({
  consultantId,
  timezone,
  workingHours,
  minimumBookingNoticeHours,
  from,
  to,
}: CalculateAvailabilityInput): Promise<AvailabilityCalculationResult> => {
  const cached = await getCachedAvailability(
    consultantId,
    from,
    to,
  );

  if (cached) {
    return {
      ok: true,
      data: cached,
      source: "cache",
    };
  }

  const localResult = await calculateLocalAvailability({
    consultantId,
    timezone,
    workingHours,
    minimumBookingNoticeHours,
    from,
    to,
  });

  if (!localResult.ok) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: localResult.message,
    };
  }

  /*
   * Google FreeBusy filtering must run here before the result
   * may be returned or cached.
   *
   * Returning localResult.data now would expose slots that may
   * conflict with the consultant's Google Calendar.
   */
  return {
    ok: false,
    code: "GOOGLE_ERROR",
    message:
      "Google Calendar availability checking is not configured yet.",
  };
};

export const cacheCompletedAvailability = async (
  consultantId: string,
  from: string,
  to: string,
  result: AvailabilityResult,
): Promise<void> => {
  await setCachedAvailability(
    consultantId,
    from,
    to,
    result,
  );
};
