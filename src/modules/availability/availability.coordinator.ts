import {
  getCachedAvailability,
  setCachedAvailability,
} from "./availability.cache.js";
import { removeBusySlots } from "./availability.conflicts.js";
import { getGoogleBusyIntervals } from "./google-freebusy.js";
import { calculateLocalAvailability } from "./availability.local.js";
import type {
  AvailabilityResult,
} from "./availability.types.js";

type CalculateAvailabilityInput = {
  consultantId: string;
  timezone: string;
  workingHours: Record<string, unknown>;
  minimumBookingNoticeHours: number;
  slotDurationMinutes: number;
  from: string;
  to: string;
};

export type AvailabilityCalculationResult =
  | {
      ok: true;
      data: AvailabilityResult;
      source:
        | "cache"
        | "calculated";
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

export const calculateAvailability = async ({
  consultantId,
  timezone,
  workingHours,
  minimumBookingNoticeHours,
  slotDurationMinutes,
  from,
  to,
}: CalculateAvailabilityInput): Promise<AvailabilityCalculationResult> => {
  const cached =
    await getCachedAvailability(
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

  const localResult =
    await calculateLocalAvailability({
      consultantId,
      timezone,
      workingHours,
      minimumBookingNoticeHours,
      slotDurationMinutes,
      from,
      to,
    });

  if (!localResult.ok) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        localResult.message,
    };
  }

  const googleResult =
    await getGoogleBusyIntervals(
      consultantId,
      from,
      to,
    );

  const completedResult: AvailabilityResult =
    googleResult.ok
      ? {
          consultant_id:
            consultantId,
          slots:
            removeBusySlots(
              localResult.data.slots,
              googleResult.intervals,
            ),
          generated_at:
            new Date().toISOString(),
          cache_ttl_seconds: 120,
          availability_mode:
            "normal",
          calendar_connected:
            true,
        }
      : {
          consultant_id:
            consultantId,
          slots:
            localResult.data.slots,
          generated_at:
            new Date().toISOString(),
          cache_ttl_seconds: 120,
          availability_mode:
            "degraded",
          calendar_connected:
            googleResult
              .calendarConnected,
        };

  if (!googleResult.ok) {
    console.warn(
      "Availability running in degraded mode",
      {
        consultantId,
        code:
          googleResult.code,
        calendarConnected:
          googleResult
            .calendarConnected,
      },
    );
  }

  await setCachedAvailability(
    consultantId,
    from,
    to,
    completedResult,
  );

  return {
    ok: true,
    data:
      completedResult,
    source: "calculated",
  };
};

export const cacheCompletedAvailability =
  async (
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
