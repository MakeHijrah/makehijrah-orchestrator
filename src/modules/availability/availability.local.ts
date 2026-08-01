import { removeBusySlots } from "./availability.conflicts.js";
import { getHeldSlotIntervals } from "./availability.holds.js";
import { getReservedConsultationIntervals } from "./availability.repository.js";
import { generateWorkingHourSlots } from "./availability.slots.js";
import type {
  AvailabilityResult,
  AvailabilitySlot,
} from "./availability.types.js";

type CalculateLocalAvailabilityInput = {
  consultantId: string;
  timezone: string;
  workingHours: Record<string, unknown>;
  minimumBookingNoticeHours: number;
  slotDurationMinutes: number;
  from: string;
  to: string;
};

export type LocalAvailabilityCalculationResult =
  | {
      ok: true;
      data: AvailabilityResult;
    }
  | {
      ok: false;
      message: string;
    };

export const calculateLocalAvailability = async ({
  consultantId,
  timezone,
  workingHours,
  minimumBookingNoticeHours,
  slotDurationMinutes,
  from,
  to,
}: CalculateLocalAvailabilityInput): Promise<LocalAvailabilityCalculationResult> => {
  let candidateSlots: AvailabilitySlot[];

  try {
    candidateSlots = generateWorkingHourSlots({
      timezone,
      workingHours,
      minimumBookingNoticeHours,
      slotDurationMinutes,
      from,
      to,
    });
  } catch (error) {
    console.error(
      "Working-hours slot generation failed:",
      error instanceof Error ? error.message : error,
    );

    return {
      ok: false,
      message: "Unable to calculate consultant working hours.",
    };
  }

  const [consultationsResult, holdsResult] = await Promise.all([
    getReservedConsultationIntervals(
      consultantId,
      from,
      to,
    ),
    getHeldSlotIntervals(consultantId),
  ]);

  if (!consultationsResult.ok) {
    return {
      ok: false,
      message: consultationsResult.message,
    };
  }

  if (!holdsResult.ok) {
    return {
      ok: false,
      message: holdsResult.message,
    };
  }

  const busyIntervals = [
    ...consultationsResult.intervals,
    ...holdsResult.intervals,
  ];

  const availableSlots = removeBusySlots(
    candidateSlots,
    busyIntervals,
  );

  return {
    ok: true,
    data: {
      consultant_id: consultantId,
      slots: availableSlots,
      generated_at: new Date().toISOString(),
      cache_ttl_seconds: 120,
      availability_mode: "degraded",
      calendar_connected: false,
    },
  };
};
