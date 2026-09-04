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
  buildDefaultSlugCandidates,
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

/*
 * The blog is a top-level surface added after Amendment 011, so
 * its routes need the same protection every other top-level route
 * has. A consultant at /blog would shadow the whole blog.
 */
describe("Reserved slugs: the blog surface", () => {
  it("reserves blog and its near misses", () => {
    for (const value of ["blog", "blogs"]) {
      assert.equal(
        isReservedSlug(value),
        true,
        `${value} must be reserved`,
      );
    }
  });

  it("reserves the syndication roots the blog owns", () => {
    for (const value of [
      "feed",
      "feeds",
      "rss",
      "atom",
      "rss.xml",
      "feed.xml",
      "atom.xml",
    ]) {
      assert.equal(
        isReservedSlug(value),
        true,
        `${value} must be reserved`,
      );
    }
  });

  it("reserves them however they are typed", () => {
    /*
     * Reservation is matched after normalization, so casing,
     * padding and the dotted form all have to land on the same
     * reserved value.
     */
    for (const value of [
      "Blog",
      "  blog  ",
      "BLOG",
      "rss.xml",
      "RSS.XML",
    ]) {
      assert.equal(
        isReservedSlug(value),
        true,
        `${value} must be reserved`,
      );
    }
  });

  it("rejects blog through the validator with SLUG_RESERVED", () => {
    const result = validateConsultantSlug("blog");

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "SLUG_RESERVED",
    );
  });

  it("never offers blog to a consultant named Blog", () => {
    /*
     * The generator validates every candidate, so reserving the
     * name is what makes it skip it rather than a second list
     * that could drift.
     */
    const candidates =
      buildDefaultSlugCandidates("Blog");

    assert.ok(
      candidates.length > 0,
      "a consultant named Blog must still get a slug",
    );

    assert.equal(
      candidates.includes("blog"),
      false,
      "the generator offered the reserved slug",
    );
  });

  it("leaves ordinary consultant slugs alone", () => {
    /*
     * The reserved set is a cost: every entry is a name no
     * consultant can have. These must not have been caught by the
     * new entries.
     */
    for (const value of [
      "aisha",
      "blogger",
      "bloggs",
      "feedback",
      "atomic",
      "russell",
    ]) {
      assert.equal(
        isReservedSlug(value),
        false,
        `${value} must remain available`,
      );

      assert.equal(
        validateConsultantSlug(value).ok,
        true,
        `${value} must still validate`,
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
