import { DateTime } from "luxon";
import { toNamedWeekdayKeys } from "../../lib/working-hours-format.js";
import type {
  AvailabilitySlot,
  WeeklyWorkingHours,
  WorkingHoursInterval,
} from "./availability.types.js";

/*
 * Slot length is supplied by the caller from
 * app_settings.consultation_duration_minutes. Amendment 007
 * section 8.5. The stride between candidate slot starts is
 * unchanged.
 */
const SLOT_INTERVAL_MINUTES = 30;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isWorkingHoursInterval = (
  value: unknown,
): value is WorkingHoursInterval => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const interval = value as Record<string, unknown>;

  return (
    typeof interval.start === "string" &&
    typeof interval.end === "string" &&
    TIME_PATTERN.test(interval.start) &&
    TIME_PATTERN.test(interval.end)
  );
};

export const normalizeWorkingHours = (
  value: Record<string, unknown>,
): WeeklyWorkingHours => {
  const normalized: WeeklyWorkingHours = {};

  /*
   * Storage became numeric weekday keys in migration 029, while
   * slot generation matches on luxon's named weekday. Rows written
   * before 029 are still named. Normalising keys first means both
   * shapes generate slots; without this a numeric row silently
   * produces an empty week and the consultant looks unbookable.
   */
  for (const [weekday, intervals] of Object.entries(
    toNamedWeekdayKeys(value),
  )) {
    if (!Array.isArray(intervals)) {
      normalized[weekday.toLowerCase()] = [];
      continue;
    }

    normalized[weekday.toLowerCase()] =
      intervals.filter(isWorkingHoursInterval);
  }

  return normalized;
};

const createLocalDateTime = (
  day: DateTime,
  time: string,
  timezone: string,
): DateTime | null => {
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  const dateTime = DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    {
      zone: timezone,
    },
  );

  return dateTime.isValid ? dateTime : null;
};

const toUtcIso = (dateTime: DateTime): string => {
  const value = dateTime.toUTC().toISO({
    suppressMilliseconds: true,
  });

  if (!value) {
    throw new Error("Unable to convert availability time to UTC.");
  }

  return value;
};

type GenerateWorkingHourSlotsInput = {
  timezone: string;
  workingHours: Record<string, unknown>;
  minimumBookingNoticeHours: number;
  slotDurationMinutes: number;
  from: string;
  to: string;
  now?: DateTime;
};

export const generateWorkingHourSlots = ({
  timezone,
  workingHours,
  minimumBookingNoticeHours,
  slotDurationMinutes,
  from,
  to,
  now = DateTime.utc(),
}: GenerateWorkingHourSlotsInput): AvailabilitySlot[] => {
  const requestedFrom = DateTime.fromISO(from, {
    setZone: true,
  }).toUTC();

  const requestedTo = DateTime.fromISO(to, {
    setZone: true,
  }).toUTC();

  if (
    !requestedFrom.isValid ||
    !requestedTo.isValid ||
    requestedTo <= requestedFrom
  ) {
    return [];
  }

  const localFrom = requestedFrom.setZone(timezone);
  const localTo = requestedTo.setZone(timezone);

  if (!localFrom.isValid || !localTo.isValid) {
    throw new Error(`Invalid consultant timezone: ${timezone}`);
  }

  const normalizedHours = normalizeWorkingHours(workingHours);

  const earliestAllowedStart = now
    .toUTC()
    .plus({
      hours: Math.max(0, minimumBookingNoticeHours),
    });

  const slots: AvailabilitySlot[] = [];

  let currentDay = localFrom.startOf("day");
  const finalDay = localTo.startOf("day");

  while (currentDay <= finalDay) {
    const weekday = currentDay.toFormat("cccc").toLowerCase();
    const intervals = normalizedHours[weekday] ?? [];

    for (const interval of intervals) {
      const intervalStart = createLocalDateTime(
        currentDay,
        interval.start,
        timezone,
      );

      const intervalEnd = createLocalDateTime(
        currentDay,
        interval.end,
        timezone,
      );

      if (
        !intervalStart ||
        !intervalEnd ||
        intervalEnd <= intervalStart
      ) {
        continue;
      }

      let slotStart = intervalStart;

      while (
        slotStart.plus({
          minutes: slotDurationMinutes,
        }) <= intervalEnd
      ) {
        const slotEnd = slotStart.plus({
          minutes: slotDurationMinutes,
        });

        const slotStartUtc = slotStart.toUTC();
        const slotEndUtc = slotEnd.toUTC();

        const insideRequestedWindow =
          slotStartUtc >= requestedFrom &&
          slotEndUtc <= requestedTo;

        const meetsMinimumNotice =
          slotStartUtc >= earliestAllowedStart;

        if (insideRequestedWindow && meetsMinimumNotice) {
          slots.push({
            start_at: toUtcIso(slotStartUtc),
            end_at: toUtcIso(slotEndUtc),
          });
        }

        slotStart = slotStart.plus({
          minutes: SLOT_INTERVAL_MINUTES,
        });
      }
    }

    currentDay = currentDay.plus({
      days: 1,
    });
  }

  return slots.sort(
    (a, b) =>
      Date.parse(a.start_at) - Date.parse(b.start_at),
  );
};
