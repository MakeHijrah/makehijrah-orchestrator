/*
 * Stored working-hours parsing.
 * PROJECT_LOCK Amendment 008 §8a, migration 029.
 *
 * Two representations exist and they are not interchangeable:
 *
 *   HTTP wire format   named   "sunday" … "saturday"
 *   Database storage   numeric "0" … "6", 0 = sunday
 *
 * The RPC converts named to numeric on the way in. This module
 * converts stored values back to named on the way out, and is the
 * single reader every consumer goes through.
 *
 * It is deliberately STRICT, and that is a reversal of the earlier
 * permissive behaviour. A permissive reader that drops unknown keys
 * turns a corrupt row into a PARTIAL schedule, and a partial
 * schedule is worse than none: a consultant is shown bookable at
 * hours they never agreed to. Silence is the wrong failure mode
 * here, so anything it cannot parse with certainty is rejected
 * whole.
 *
 * Rejected outright:
 *   - non-objects, including arrays, strings and numbers
 *   - unknown keys
 *   - mixed numeric and named keys
 *   - semantic duplicates, e.g. "0" alongside "sunday"
 *   - keys valid only after trimming, e.g. " sunday "
 *   - keys valid only after case folding, e.g. "Sunday"
 *
 * Nothing is trimmed, lower-cased or coerced. A key is either
 * exactly right or the whole schedule is refused.
 */

export const NUMERIC_TO_NAMED_WEEKDAY: Readonly<
  Record<string, string>
> = {
  "0": "sunday",
  "1": "monday",
  "2": "tuesday",
  "3": "wednesday",
  "4": "thursday",
  "5": "friday",
  "6": "saturday",
};

const NAMED_WEEKDAYS: ReadonlySet<string> =
  new Set(
    Object.values(
      NUMERIC_TO_NAMED_WEEKDAY,
    ),
  );

const NUMERIC_WEEKDAYS: ReadonlySet<string> =
  new Set(
    Object.keys(
      NUMERIC_TO_NAMED_WEEKDAY,
    ),
  );

/*
 * Exact membership. No trimming, no case folding: a key that would
 * only become valid after normalisation is not valid, because
 * accepting it would mean guessing what the writer meant.
 */
export const isNamedWeekday = (
  key: string,
): boolean => NAMED_WEEKDAYS.has(key);

export const isNumericWeekday = (
  key: string,
): boolean =>
  NUMERIC_WEEKDAYS.has(key);

export type StoredWorkingHoursFormat =
  | "numeric"
  | "named";

export type ParsedWorkingHours =
  | {
      ok: true;
      /* Always named, whatever the stored format was. */
      value: Record<string, unknown>;
      sourceFormat: StoredWorkingHoursFormat;
    }
  | {
      ok: false;
      /*
       * Short, safe reason. Never contains stored values, only key
       * names and shape facts, so it is safe to log.
       */
      reason: string;
    };

/*
 * Parse a stored working-hours value into the named form.
 *
 * An empty object is valid and parses as numeric: it carries no
 * key that could contradict either format, and the column default
 * is '{}'.
 */
export const parseStoredWorkingHours = (
  value: unknown,
): ParsedWorkingHours => {
  if (
    value === null ||
    value === undefined
  ) {
    return {
      ok: false,
      reason:
        "stored working hours are null or undefined",
    };
  }

  if (typeof value !== "object") {
    return {
      ok: false,
      reason: `stored working hours are ${typeof value}, expected an object`,
    };
  }

  if (Array.isArray(value)) {
    return {
      ok: false,
      reason:
        "stored working hours are an array, expected an object",
    };
  }

  const entries = Object.entries(
    value as Record<string, unknown>,
  );

  if (entries.length === 0) {
    return {
      ok: true,
      value: {},
      sourceFormat: "numeric",
    };
  }

  let numericCount = 0;
  let namedCount = 0;

  for (const [key] of entries) {
    if (isNumericWeekday(key)) {
      numericCount += 1;
      continue;
    }

    if (isNamedWeekday(key)) {
      namedCount += 1;
      continue;
    }

    /*
     * Report whether a near-miss would have been accepted by a
     * looser reader, so a corrupt row is diagnosable without
     * echoing its contents.
     */
    const trimmedLower = key
      .trim()
      .toLowerCase();

    const nearMiss =
      isNamedWeekday(trimmedLower) ||
      isNumericWeekday(key.trim());

    return {
      ok: false,
      reason: nearMiss
        ? `stored working hours contain the non-canonical weekday key "${key}"`
        : `stored working hours contain the unknown weekday key "${key}"`,
    };
  }

  if (numericCount > 0 && namedCount > 0) {
    return {
      ok: false,
      reason:
        "stored working hours mix numeric and named weekday keys",
    };
  }

  if (namedCount > 0) {
    return {
      ok: true,
      value: Object.fromEntries(entries),
      sourceFormat: "named",
    };
  }

  /*
   * Numeric. Collisions cannot arise here - a numeric-only object
   * has no named key to collide with, and JSON object keys are
   * already unique - but the mapping is built explicitly rather
   * than by mutation so a future change cannot introduce a silent
   * overwrite.
   */
  const named: Record<
    string,
    unknown
  > = {};

  for (const [
    key,
    intervals,
  ] of entries) {
    const mapped =
      NUMERIC_TO_NAMED_WEEKDAY[key]!;

    if (mapped in named) {
      return {
        ok: false,
        reason: `stored working hours map two keys onto ${mapped}`,
      };
    }

    named[mapped] = intervals;
  }

  return {
    ok: true,
    value: named,
    sourceFormat: "numeric",
  };
};

/*
 * Convenience for consumers that only need the named form and
 * treat any parse failure as "no usable hours". Callers that must
 * distinguish "empty" from "corrupt" use parseStoredWorkingHours
 * directly.
 */
export const toNamedWorkingHoursOrNull = (
  value: unknown,
): Record<string, unknown> | null => {
  const parsed =
    parseStoredWorkingHours(value);

  return parsed.ok
    ? parsed.value
    : null;
};

/*
 * Raised when a stored row cannot be parsed and the caller cannot
 * meaningfully continue - notably the profile response mapper,
 * which must not return a partial week.
 */
export class StoredWorkingHoursError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      "The stored working hours could not be read.",
    );

    this.name =
      "StoredWorkingHoursError";
    this.reason = reason;
  }
}
