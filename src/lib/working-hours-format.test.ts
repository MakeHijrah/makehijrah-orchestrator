/*
 * Weekday key format converters, and the readers that depend on
 * them. Migration 029.
 *
 * The load-bearing case is slot generation: it matches on luxon's
 * named weekday, while storage is numeric from migration 029
 * onward. A converter that missed that would not throw - it would
 * silently produce an empty week, and every consultant would look
 * unbookable rather than broken.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";

import {
  isNamedWeekday,
  isNumericWeekday,
  toNamedWeekdayKeys,
  toNamedWorkingHours,
  toNumericWeekdayKeys,
} from "./working-hours-format.js";
import {
  generateWorkingHourSlots,
  normalizeWorkingHours,
} from "../modules/availability/availability.slots.js";
import { hasUsableWorkingHours } from "../modules/consultant-profile/consultant-profile.working-hours.js";

const INTERVAL = [{ start: "09:00", end: "17:00" }];

describe("weekday key mapping", () => {
  it("maps all seven days both ways", () => {
    const named = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];

    named.forEach((day, index) => {
      assert.deepEqual(
        toNumericWeekdayKeys({ [day]: INTERVAL }),
        { [String(index)]: INTERVAL },
        `${day} must map to ${index}`,
      );
      assert.deepEqual(
        toNamedWeekdayKeys({ [String(index)]: INTERVAL }),
        { [day]: INTERVAL },
        `${index} must map to ${day}`,
      );
    });
  });

  it("recognises each format", () => {
    assert.equal(isNamedWeekday("sunday"), true);
    assert.equal(isNamedWeekday("0"), false);
    assert.equal(isNumericWeekday("0"), true);
    assert.equal(isNumericWeekday("sunday"), false);
  });

  it("passes interval values through untouched", () => {
    const multi = [
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ];

    assert.deepEqual(
      toNamedWeekdayKeys({ "5": multi })["friday"],
      multi,
      "order and values must survive key conversion",
    );
  });

  it("is idempotent and accepts either input format", () => {
    const once = toNamedWeekdayKeys({ "0": INTERVAL });
    assert.deepEqual(toNamedWeekdayKeys(once), once);
    assert.deepEqual(
      toNamedWeekdayKeys({ sunday: INTERVAL }),
      once,
    );
  });

  it("drops unrecognised keys rather than throwing", () => {
    assert.deepEqual(
      toNamedWeekdayKeys({ funday: INTERVAL, "9": INTERVAL }),
      {},
    );
  });

  it("returns non-objects unchanged", () => {
    assert.equal(toNamedWorkingHours(null), null);
    assert.equal(toNamedWorkingHours("x"), "x");
    assert.deepEqual(toNamedWorkingHours([1]), [1]);
  });
});

describe("availability tolerates numeric storage", () => {
  it("normalises numeric keys to named", () => {
    assert.deepEqual(
      normalizeWorkingHours({ "1": INTERVAL }),
      { monday: INTERVAL },
    );
  });

  it("generates identical slots from numeric and named storage", () => {
    /*
     * now is pinned so the minimum-notice filter cannot silently
     * drop every slot when the wall clock moves past the fixture
     * date, which would make this comparison vacuous.
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
    assert.deepEqual(
      fromNumeric,
      fromNamed,
      "numeric storage must not silently produce an empty week",
    );
  });
});

describe("completeness tolerates numeric storage", () => {
  it("accepts both formats as usable working hours", () => {
    assert.equal(hasUsableWorkingHours({ monday: INTERVAL }), true);
    assert.equal(hasUsableWorkingHours({ "1": INTERVAL }), true);
  });

  it("still rejects an empty or unusable week in either format", () => {
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
