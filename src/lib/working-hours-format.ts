/*
 * Working-hours weekday key formats.
 * PROJECT_LOCK Amendment 008, as amended by migration 029.
 *
 * There are two representations and they are not interchangeable:
 *
 *   HTTP wire format   named   "sunday" … "saturday"
 *   Database storage   numeric "0" … "6", 0 = sunday
 *
 * The RPC converts named to numeric on the way in. The orchestrator
 * converts numeric back to named on the way out. Everything
 * in between - slot generation, completeness evaluation - works in
 * the named form, because that is what luxon's weekday formatting
 * produces and what the availability module has always used.
 *
 * toNamedWeekdayKeys accepts EITHER representation deliberately.
 * Rows written before migration 029 carry named keys and rows
 * written after carry numeric ones, so every internal reader has to
 * cope with both for as long as un-migrated rows can exist. A
 * reader that understood only one format would silently produce an
 * empty week for the other, which is exactly the failure that
 * makes a consultant look unbookable rather than broken.
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

export const NAMED_TO_NUMERIC_WEEKDAY: Readonly<
  Record<string, string>
> = {
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
};

export const isNamedWeekday = (
  key: string,
): boolean =>
  Object.prototype.hasOwnProperty.call(
    NAMED_TO_NUMERIC_WEEKDAY,
    key.trim().toLowerCase(),
  );

export const isNumericWeekday = (
  key: string,
): boolean =>
  Object.prototype.hasOwnProperty.call(
    NUMERIC_TO_NAMED_WEEKDAY,
    key.trim(),
  );

/*
 * Rewrite an arbitrary working-hours object so every recognised
 * weekday key is named.
 *
 * Values are passed through untouched: this converts keys only and
 * never inspects, reorders or rewrites an interval. Unrecognised
 * keys are dropped, matching the permissive contract the
 * availability module has always had - slot generation must never
 * throw on a malformed stored row.
 */
export const toNamedWeekdayKeys = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<
    string,
    unknown
  > = {};

  for (const [
    rawKey,
    intervals,
  ] of Object.entries(value)) {
    const trimmed = rawKey.trim();

    const named =
      NUMERIC_TO_NAMED_WEEKDAY[
        trimmed
      ] ??
      (isNamedWeekday(trimmed)
        ? trimmed.toLowerCase()
        : null);

    if (named === null) {
      continue;
    }

    result[named] = intervals;
  }

  return result;
};

/*
 * The inverse, used by the HTTP response mapper so the wire format
 * stays named regardless of how the row is stored.
 */
export const toNumericWeekdayKeys = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<
    string,
    unknown
  > = {};

  for (const [
    rawKey,
    intervals,
  ] of Object.entries(value)) {
    const trimmed = rawKey.trim();

    const numeric = isNumericWeekday(
      trimmed,
    )
      ? trimmed
      : (NAMED_TO_NUMERIC_WEEKDAY[
          trimmed.toLowerCase()
        ] ?? null);

    if (numeric === null) {
      continue;
    }

    result[numeric] = intervals;
  }

  return result;
};

/*
 * Response projection: whatever is stored, present it named.
 *
 * Returns the input unchanged when it is not an object, so a null
 * or malformed stored value round-trips rather than becoming {}.
 */
export const toNamedWorkingHours = (
  value: unknown,
): unknown => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }

  return toNamedWeekdayKeys(
    value as Record<string, unknown>,
  );
};
