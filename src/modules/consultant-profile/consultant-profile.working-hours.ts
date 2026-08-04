import { parseStoredWorkingHours } from "../../lib/working-hours-format.js";
import type {
  WeeklyWorkingHours,
  WorkingHoursInterval,
} from "../availability/availability.types.js";

/*
 * Working-hours validation for consultant profile saves.
 * PROJECT_LOCK Amendment 008.
 *
 * The availability module already owns the runtime convention:
 * lowercase weekday keys, HH:MM 24-hour strings, arrays of
 * {start,end}. normalizeWorkingHours there is deliberately
 * permissive - it silently drops anything malformed, because slot
 * generation must never crash on a bad row.
 *
 * A profile save is the opposite situation. A consultant who
 * submits a malformed schedule must be told, not silently given an
 * empty week. So this validates strictly and reports, then
 * normalises into exactly the shape the availability module reads.
 */

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday =
  (typeof WEEKDAYS)[number];

const WEEKDAY_SET = new Set<string>(
  WEEKDAYS,
);

/* Matches availability.slots.ts exactly. */
const TIME_PATTERN =
  /^([01]\d|2[0-3]):([0-5]\d)$/;

export type WorkingHoursValidation =
  | {
      ok: true;
      /*
       * Normalised: lowercase weekday keys, intervals sorted by
       * start, empty weekdays omitted.
       */
      workingHours: WeeklyWorkingHours;
      intervalCount: number;
    }
  | {
      ok: false;
      /*
       * Human-readable reasons, safe to return. Never contains
       * database text.
       */
      issues: string[];
    };

const toMinutes = (
  time: string,
): number => {
  const [hours, minutes] =
    time.split(":");

  return (
    Number(hours) * 60 +
    Number(minutes)
  );
};

/*
 * Validates shape and returns the normalised week.
 *
 * Not every weekday is required. A weekday may legitimately carry
 * an empty array, which means "not available that day"; such days
 * are dropped from the normalised result rather than stored as
 * empty arrays.
 */
export const validateWorkingHours = (
  value: unknown,
): WorkingHoursValidation => {
  const issues: string[] = [];

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {
      ok: false,
      issues: [
        "working_hours must be an object keyed by weekday.",
      ],
    };
  }

  const normalized: WeeklyWorkingHours =
    {};

  let intervalCount = 0;

  for (const [
    rawKey,
    rawIntervals,
  ] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const weekday =
      rawKey.trim().toLowerCase();

    if (!WEEKDAY_SET.has(weekday)) {
      issues.push(
        `working_hours contains an unsupported day key: ${rawKey}.`,
      );
      continue;
    }

    if (!Array.isArray(rawIntervals)) {
      issues.push(
        `working_hours.${weekday} must be an array of intervals.`,
      );
      continue;
    }

    const dayIntervals: WorkingHoursInterval[] =
      [];

    for (const rawInterval of rawIntervals) {
      if (
        !rawInterval ||
        typeof rawInterval !== "object" ||
        Array.isArray(rawInterval)
      ) {
        issues.push(
          `working_hours.${weekday} contains an entry that is not an interval object.`,
        );
        continue;
      }

      const interval =
        rawInterval as Record<
          string,
          unknown
        >;

      const start = interval.start;
      const end = interval.end;

      if (
        typeof start !== "string" ||
        !TIME_PATTERN.test(start) ||
        typeof end !== "string" ||
        !TIME_PATTERN.test(end)
      ) {
        issues.push(
          `working_hours.${weekday} contains an interval whose start or end is not a valid HH:MM time.`,
        );
        continue;
      }

      if (
        toMinutes(end) <=
        toMinutes(start)
      ) {
        issues.push(
          `working_hours.${weekday} contains an interval whose end (${end}) is not after its start (${start}).`,
        );
        continue;
      }

      dayIntervals.push({
        start,
        end,
      });
    }

    /*
     * Overlap detection runs on the sorted list, so a single pass
     * comparing each interval to its predecessor is sufficient.
     * Touching intervals (09:00-10:00 then 10:00-11:00) are
     * allowed; only a genuine overlap is rejected.
     */
    dayIntervals.sort(
      (first, second) =>
        toMinutes(first.start) -
        toMinutes(second.start),
    );

    for (
      let index = 1;
      index < dayIntervals.length;
      index += 1
    ) {
      const previous =
        dayIntervals[index - 1]!;
      const current =
        dayIntervals[index]!;

      if (
        toMinutes(current.start) <
        toMinutes(previous.end)
      ) {
        issues.push(
          `working_hours.${weekday} contains overlapping intervals (${previous.start}-${previous.end} and ${current.start}-${current.end}).`,
        );
      }
    }

    if (dayIntervals.length > 0) {
      normalized[weekday] =
        dayIntervals;
      intervalCount +=
        dayIntervals.length;
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  return {
    ok: true,
    workingHours: normalized,
    intervalCount,
  };
};

/*
 * Completeness helper: does this stored value carry at least one
 * usable interval?
 *
 * Deliberately tolerant of already-stored data that predates this
 * validator, which is why it re-validates rather than trusting the
 * row. A stored week that cannot produce a slot is not complete.
 */
export const hasUsableWorkingHours = (
  value: unknown,
): boolean => {
  /*
   * Reads a STORED value: numeric-keyed from migration 029 onward,
   * named-keyed before it. Both are accepted; anything else makes
   * the profile incomplete rather than partially complete, because
   * a schedule that cannot be read cannot be honoured.
   */
  const parsed =
    parseStoredWorkingHours(value);

  if (!parsed.ok) {
    return false;
  }

  const result =
    validateWorkingHours(parsed.value);

  return (
    result.ok &&
    result.intervalCount > 0
  );
};
