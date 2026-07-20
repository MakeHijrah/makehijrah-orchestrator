import type { AvailabilitySlot } from "./availability.types.js";

export type BusyInterval = {
  start_at: string;
  end_at: string;
};

const intervalsOverlap = (
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean => {
  return firstStart < secondEnd && firstEnd > secondStart;
};

const isValidInterval = (
  interval: BusyInterval,
): boolean => {
  const start = Date.parse(interval.start_at);
  const end = Date.parse(interval.end_at);

  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start
  );
};

export const removeBusySlots = (
  slots: AvailabilitySlot[],
  busyIntervals: BusyInterval[],
): AvailabilitySlot[] => {
  const validBusyIntervals = busyIntervals.filter(isValidInterval);

  return slots.filter((slot) => {
    const slotStart = Date.parse(slot.start_at);
    const slotEnd = Date.parse(slot.end_at);

    if (
      !Number.isFinite(slotStart) ||
      !Number.isFinite(slotEnd) ||
      slotEnd <= slotStart
    ) {
      return false;
    }

    const hasConflict = validBusyIntervals.some((busy) => {
      const busyStart = Date.parse(busy.start_at);
      const busyEnd = Date.parse(busy.end_at);

      return intervalsOverlap(
        slotStart,
        slotEnd,
        busyStart,
        busyEnd,
      );
    });

    return !hasConflict;
  });
};
