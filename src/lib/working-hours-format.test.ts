/*
 * Strict stored working-hours parser, and the three consumers that
 * depend on it. Migration 029.
 *
 * The property under test throughout is that a value the parser
 * cannot read with certainty is refused WHOLE. A permissive reader
 * would turn a corrupt row into a partial schedule, and a partial
 * schedule offers a consultant's time at hours they never agreed
 * to - a worse outcome than offering none.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";

import {
  isNamedWeekday,
  isNumericWeekday,
  parseStoredWorkingHours,
  StoredWorkingHoursError,
  toNamedWorkingHoursOrNull,
} from "./working-hours-format.js";
import {
  generateWorkingHourSlots,
  normalizeWorkingHours,
} from "../modules/availability/availability.slots.js";
import { hasUsableWorkingHours } from "../modules/consultant-profile/consultant-profile.working-hours.js";

const INTERVAL = [{ start: "09:00", end: "17:00" }];

const NAMED_BY_INDEX = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const reasonOf = (value: unknown): string => {
  const parsed = parseStoredWorkingHours(value);
  assert.equal(parsed.ok, false, "expected a rejection");
  return (parsed as { reason: string }).reason;
};

describe("strict parser: accepted forms", () => {
  it("converts all seven numeric keys", () => {
    NAMED_BY_INDEX.forEach((day, index) => {
      const parsed = parseStoredWorkingHours({
        [String(index)]: INTERVAL,
      });

      assert.equal(parsed.ok, true, `${index} must parse`);
      assert.deepEqual(
        (parsed as { value: unknown }).value,
        { [day]: INTERVAL },
        `${index} must map to ${day}`,
      );
      assert.equal(
        (parsed as { sourceFormat: string }).sourceFormat,
        "numeric",
      );
    });
  });

  it("keeps valid named input equivalent", () => {
    const parsed = parseStoredWorkingHours({
      sunday: INTERVAL,
    });

    assert.equal(parsed.ok, true);
    assert.deepEqual(
      (parsed as { value: unknown }).value,
      { sunday: INTERVAL },
    );
    assert.equal(
      (parsed as { sourceFormat: string }).sourceFormat,
      "named",
    );
  });

  it("treats numeric and named storage as equivalent", () => {
    assert.deepEqual(
      toNamedWorkingHoursOrNull({ "0": INTERVAL }),
      toNamedWorkingHoursOrNull({ sunday: INTERVAL }),
    );
  });

  it("accepts an empty object", () => {
    const parsed = parseStoredWorkingHours({});
    assert.equal(parsed.ok, true);
    assert.deepEqual((parsed as { value: unknown }).value, {});
  });

  it("passes interval values through untouched", () => {
    const multi = [
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ];

    assert.deepEqual(
      toNamedWorkingHoursOrNull({ "5": multi })!["friday"],
      multi,
    );
  });
});

describe("strict parser: rejected forms", () => {
  it("rejects a non-object", () => {
    for (const bad of [null, undefined, "x", 7, true]) {
      assert.equal(
        parseStoredWorkingHours(bad).ok,
        false,
        `${String(bad)} must be rejected`,
      );
    }
    assert.match(reasonOf("x"), /string/);
  });

  it("rejects an array", () => {
    assert.match(reasonOf([INTERVAL]), /array/);
  });

  it("rejects an unknown key and refuses the whole schedule", () => {
    const parsed = parseStoredWorkingHours({
      monday: INTERVAL,
      funday: INTERVAL,
    });

    assert.equal(parsed.ok, false);
    assert.ok(
      !("value" in parsed),
      "a rejected schedule must carry no partial value",
    );
    assert.match(reasonOf({ funday: INTERVAL }), /unknown/);
  });

  it("rejects mixed numeric and named keys", () => {
    assert.match(
      reasonOf({ "0": INTERVAL, monday: INTERVAL }),
      /mix/,
    );
  });

  it('rejects the semantic duplicate "0" plus "sunday"', () => {
    const parsed = parseStoredWorkingHours({
      "0": INTERVAL,
      sunday: INTERVAL,
    });

    assert.equal(
      parsed.ok,
      false,
      "the same weekday twice in two formats must never resolve",
    );
  });

  it('rejects uppercase "Sunday"', () => {
    assert.equal(
      parseStoredWorkingHours({ Sunday: INTERVAL }).ok,
      false,
    );
    assert.match(reasonOf({ Sunday: INTERVAL }), /non-canonical/);
  });

  it('rejects the whitespace key " sunday "', () => {
    assert.equal(
      parseStoredWorkingHours({ " sunday ": INTERVAL }).ok,
      false,
    );
    assert.match(
      reasonOf({ " sunday ": INTERVAL }),
      /non-canonical/,
    );
  });

  it('rejects the whitespace numeric key " 0 "', () => {
    assert.equal(
      parseStoredWorkingHours({ " 0 ": INTERVAL }).ok,
      false,
    );
  });

  it("never returns a partial week for malformed input", () => {
    for (const bad of [
      { monday: INTERVAL, funday: INTERVAL },
      { "1": INTERVAL, Sunday: INTERVAL },
      { "1": INTERVAL, " 2 ": INTERVAL },
    ]) {
      assert.equal(toNamedWorkingHoursOrNull(bad), null);
    }
  });

  it("exact membership does not normalise", () => {
    assert.equal(isNamedWeekday("sunday"), true);
    assert.equal(isNamedWeekday("Sunday"), false);
    assert.equal(isNamedWeekday(" sunday "), false);
    assert.equal(isNumericWeekday("0"), true);
    assert.equal(isNumericWeekday(" 0 "), false);
  });
});

describe("availability consumer", () => {
  /*
   * now is pinned so the minimum-notice filter cannot silently drop
   * every slot when the wall clock passes the fixture date, which
   * would make the comparison vacuous.
   */
  const args = {
    timezone: "UTC",
    minimumBookingNoticeHours: 0,
    slotDurationMinutes: 60,
    from: "2026-08-03T00:00:00Z",
    to: "2026-08-03T23:59:00Z",
    now: DateTime.fromISO("2026-08-01T00:00:00Z", {
      zone: "utc",
    }),
  };

  it("generates identical slots from numeric and named storage", () => {
    /* 2026-08-03 is a Monday. */
    const fromNamed = generateWorkingHourSlots({
      ...args,
      workingHours: { monday: INTERVAL },
    });

    const fromNumeric = generateWorkingHourSlots({
      ...args,
      workingHours: { "1": INTERVAL },
    });

    assert.ok(
      fromNamed.length > 0,
      "the named baseline must produce slots or this proves nothing",
    );
    assert.deepEqual(fromNumeric, fromNamed);
  });

  it("generates ZERO slots for invalid storage, never a partial week", () => {
    for (const bad of [
      { monday: INTERVAL, funday: INTERVAL },
      { "1": INTERVAL, sunday: INTERVAL },
      { Monday: INTERVAL },
      [INTERVAL] as unknown as Record<string, unknown>,
    ]) {
      const slots = generateWorkingHourSlots({
        ...args,
        workingHours: bad,
      });

      assert.deepEqual(
        slots,
        [],
        "a corrupt row must offer no time at all",
      );
    }
  });

  it("normalises numeric keys and empties an invalid week", () => {
    assert.deepEqual(normalizeWorkingHours({ "1": INTERVAL }), {
      monday: INTERVAL,
    });
    assert.deepEqual(
      normalizeWorkingHours({ "1": INTERVAL, funday: INTERVAL }),
      {},
    );
  });
});

describe("completeness consumer", () => {
  it("accepts either valid format", () => {
    assert.equal(hasUsableWorkingHours({ monday: INTERVAL }), true);
    assert.equal(hasUsableWorkingHours({ "1": INTERVAL }), true);
  });

  it("returns false for invalid storage", () => {
    for (const bad of [
      { funday: INTERVAL },
      { "1": INTERVAL, monday: INTERVAL },
      { Sunday: INTERVAL },
      " sunday ",
      [INTERVAL],
      null,
    ]) {
      assert.equal(
        hasUsableWorkingHours(bad),
        false,
        `${JSON.stringify(bad)} must not count as complete`,
      );
    }
  });

  it("still rejects an empty or unusable week", () => {
    assert.equal(hasUsableWorkingHours({}), false);
    assert.equal(hasUsableWorkingHours({ "1": [] }), false);
    assert.equal(
      hasUsableWorkingHours({
        "1": [{ start: "17:00", end: "09:00" }],
      }),
      false,
    );
  });
});

describe("StoredWorkingHoursError", () => {
  it("carries a safe reason and a generic message", () => {
    const error = new StoredWorkingHoursError(
      "stored working hours are an array, expected an object",
    );

    assert.equal(
      error.message,
      "The stored working hours could not be read.",
    );
    assert.match(error.reason, /array/);
    assert.ok(!error.message.includes("array"));
  });
});
