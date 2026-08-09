/*
 * Consultant slug rules. Amendment 011.
 *
 * A published consultant lives at a ROOT url, which puts their
 * slug in the same namespace as every top-level route the frontend
 * owns. The database enforces format and uniqueness; the reserved
 * list is here, because it is a fact about the routing table
 * rather than about the schema.
 *
 * Nothing in this file touches a database, which is the point: the
 * whole reserved list can be asserted without one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDirectBookingUrl,
  isReservedSlug,
  normalizeSlug,
  validateConsultantSlug,
} from "./direct-booking.slug.js";

describe("Slug normalization", () => {
  it("trims, lowercases and hyphenates", () => {
    assert.equal(
      normalizeSlug("  Aisha Rahman  "),
      "aisha-rahman",
    );

    assert.equal(
      normalizeSlug("AISHA_RAHMAN"),
      "aisha-rahman",
    );
  });

  it("strips diacritics rather than replacing them", () => {
    /*
     * NFKD then dropping the combining marks. Without the
     * decomposition step the composed character is simply
     * non-alphanumeric, and "Aïsha" would become "a-sha" — a
     * different person's name.
     */
    assert.equal(normalizeSlug("Aïsha"), "aisha");
    assert.equal(normalizeSlug("Zoë"), "zoe");
    assert.equal(normalizeSlug("Ítalo"), "italo");
  });

  it("collapses runs and trims stray hyphens", () => {
    assert.equal(
      normalizeSlug("--aisha---rahman--"),
      "aisha-rahman",
    );

    assert.equal(
      normalizeSlug("aisha   ///   rahman"),
      "aisha-rahman",
    );

    assert.equal(normalizeSlug("!!!"), "");
  });

  it("produces a value the database's format check accepts", () => {
    const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

    for (const input of [
      "Aisha Rahman",
      "  Dr. Yusuf  Al-Amin ",
      "consultant#1",
      "MÜNCHEN relocation",
    ]) {
      assert.match(normalizeSlug(input), pattern);
    }
  });
});

describe("Reserved slugs", () => {
  /*
   * Every name Amendment 011 requires. A regression that dropped
   * one would hand a consultant a route the frontend owns.
   */
  const REQUIRED = [
    "admin",
    "dashboard",
    "consultant",
    "consultants",
    "consultation",
    "consultations",
    "login",
    "logout",
    "onboard",
    "api",
    "privacy",
    "terms",
    "finance",
    "settings",
    "profile",
    "messages",
    "earnings",
    "signup",
    "signin",
    "auth",
    "static",
    "assets",
    "public",
    "_build",
    "favicon.ico",
    "robots.txt",
    "sitemap.xml",

    /* Added by Amendment 012's route audit. */
    "contact",
    "about",
    "privacy-policy",
    "terms-of-service",
  ];

  it("reserves every name the amendment names", () => {
    for (const name of REQUIRED) {
      assert.equal(
        isReservedSlug(name),
        true,
        `${name} must be reserved`,
      );
    }
  });

  it("reserves them however they are typed", () => {
    /*
     * The check runs on the NORMALIZED value. Matching the raw
     * input would let every one of these through.
     */
    for (const variant of [
      "Admin",
      "  ADMIN  ",
      "_build",
      "-admin-",
      "FAVICON.ICO",
      "Robots.txt",
    ]) {
      assert.equal(
        isReservedSlug(variant),
        true,
        `${variant} must be reserved`,
      );
    }
  });

  it("rejects a reserved slug with a reason a consultant can act on", () => {
    const result = validateConsultantSlug("Dashboard");

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "SLUG_RESERVED",
    );
  });

  it("leaves ordinary names alone", () => {
    for (const name of [
      "aisha",
      "yusuf-al-amin",
      "relocation101",
      "administrator",
      "consultation-with-aisha",
    ]) {
      assert.equal(
        isReservedSlug(name),
        false,
        `${name} must not be reserved`,
      );
    }
  });
});

describe("Slug validation", () => {
  it("returns the normalized value to store", () => {
    const result = validateConsultantSlug(
      "  Aïsha  Rahman ",
    );

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.slug,
      "aisha-rahman",
    );
  });

  it("enforces the database's length bounds", () => {
    assert.equal(
      validateConsultantSlug("ab").ok,
      false,
    );

    assert.equal(
      validateConsultantSlug("abc").ok,
      true,
    );

    assert.equal(
      validateConsultantSlug("a".repeat(60)).ok,
      true,
    );

    assert.equal(
      validateConsultantSlug("a".repeat(61)).ok,
      false,
    );
  });

  it("refuses input that normalizes to nothing", () => {
    const result = validateConsultantSlug("///");

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "SLUG_EMPTY",
    );
  });
});

describe("Booking URL", () => {
  it("is built from the frontend origin", () => {
    assert.equal(
      buildDirectBookingUrl({
        origin: "https://makehijrah.test",
        slug: "aisha",
      }),
      "https://makehijrah.test/aisha",
    );
  });

  it("does not double the separator", () => {
    assert.equal(
      buildDirectBookingUrl({
        origin: "https://makehijrah.test/",
        slug: "aisha",
      }),
      "https://makehijrah.test/aisha",
    );
  });
});
