/*
 * Consultant slug rules. PROJECT_LOCK Amendment 011.
 *
 * A published consultant lives at a ROOT url — makehijrah.com/aisha
 * — which puts their slug in the same namespace as every top-level
 * route the frontend owns. So the authority is split, deliberately:
 *
 *   the DATABASE owns format and uniqueness, because those are
 *   properties of the value and belong where the value lives;
 *
 *   the ORCHESTRATOR owns the RESERVED set, because that list is a
 *   fact about the frontend's ROUTING TABLE. It changes when a
 *   route is added, not when the schema changes. Encoding it in a
 *   migration — or in a reserved_slugs table — would guarantee the
 *   two drift apart, and the day they drift a consultant claims
 *   /dashboard.
 *
 * This module is pure. It reads nothing and writes nothing, which
 * is what lets the whole reserved list be tested without a
 * database.
 */

/*
 * Everything the frontend routes to, or reasonably might.
 *
 * Erring wide costs a consultant one alternative slug. Erring
 * narrow costs the platform a route. When adding a top-level page
 * to the frontend, add it here in the same change.
 */
const RESERVED_SLUGS: readonly string[] = [
  /* Required by Amendment 011. Do not remove any of these. */
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

  /*
   * The rest of the routing table and its near misses. A visitor
   * who mistypes one of these should get a 404, not a stranger's
   * booking page.
   */
  "about",
  "account",
  "billing",
  "book",
  "booking",
  "bookings",
  "checkout",
  "client",
  "clients",
  "contact",
  "cookies",
  "faq",
  "help",
  "home",
  "invite",
  "invites",
  "me",
  "onboarding",
  "password",
  "pay",
  "payment",
  "payments",
  "payout",
  "payouts",
  "pricing",
  "refund",
  "refunds",
  "register",
  "reset",
  "search",
  "service",
  "services",
  "support",
  "user",
  "users",
  "verify",
  "webhook",
  "webhooks",
  "www",
];

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 60;

/*
 * The database's format constraint, restated. Kept identical on
 * purpose: a value this accepts must be storable, so a consultant
 * never sees a 500 from a constraint the API said was fine.
 */
const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/*
 * Trim, lowercase, decompose, drop the combining marks, turn every
 * run of anything else into a single hyphen, and trim the hyphens
 * off the ends.
 *
 * NFKD then stripping \p{M} is what turns "Aïsha" into "aisha"
 * rather than "a-sha": decomposition splits the ï into an i and a
 * combining diaeresis, and only the mark is removed. Without the
 * decomposition step the composed character is simply
 * non-alphanumeric and becomes a hyphen.
 */
export const normalizeSlug = (
  input: string,
): string =>
  input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

/*
 * Reserved names are matched AFTER normalization, against
 * normalized reserved values.
 *
 * Both halves matter. Matching the raw input would let "Admin" and
 * " admin " through. Not normalizing the list would let
 * "favicon.ico" through, because it normalizes to "favicon-ico"
 * and that string is not literally in the list above — the list is
 * written the way the routes are written, and the normalizer is
 * what reconciles the two.
 */
const RESERVED_NORMALIZED: ReadonlySet<string> =
  new Set(
    RESERVED_SLUGS.flatMap((value) => [
      value.toLowerCase(),
      normalizeSlug(value),
    ]).filter(
      (value) => value.length > 0,
    ),
  );

export const isReservedSlug = (
  candidate: string,
): boolean =>
  RESERVED_NORMALIZED.has(
    normalizeSlug(candidate),
  );

export type SlugValidationResult =
  | {
      ok: true;
      slug: string;
    }
  | {
      ok: false;
      code:
        | "SLUG_EMPTY"
        | "SLUG_TOO_SHORT"
        | "SLUG_TOO_LONG"
        | "SLUG_INVALID"
        | "SLUG_RESERVED";
      message: string;
    };

/*
 * Normalize, then judge. The returned slug is the one to store and
 * the one that will appear in the URL — a caller must never store
 * the raw input.
 *
 * Reserved is checked BEFORE length, so a consultant who asks for
 * "api" is told it is taken by the platform rather than that it is
 * too short. Both are true; only one is useful.
 */
export const validateConsultantSlug = (
  input: string,
): SlugValidationResult => {
  const slug = normalizeSlug(input);

  if (slug.length === 0) {
    return {
      ok: false,
      code: "SLUG_EMPTY",
      message:
        "Enter a booking link that contains at least one letter or number.",
    };
  }

  if (RESERVED_NORMALIZED.has(slug)) {
    return {
      ok: false,
      code: "SLUG_RESERVED",
      message:
        "That booking link is reserved by MakeHijrah. Please choose another.",
    };
  }

  if (slug.length < SLUG_MIN_LENGTH) {
    return {
      ok: false,
      code: "SLUG_TOO_SHORT",
      message: `A booking link must be at least ${SLUG_MIN_LENGTH} characters.`,
    };
  }

  if (slug.length > SLUG_MAX_LENGTH) {
    return {
      ok: false,
      code: "SLUG_TOO_LONG",
      message: `A booking link may be at most ${SLUG_MAX_LENGTH} characters.`,
    };
  }

  /*
   * Unreachable through the normalizer, which can only emit this
   * shape. Kept because it is the database's constraint, and the
   * day someone calls this with a pre-normalized value it is the
   * difference between a 400 and a 500.
   */
  if (!SLUG_FORMAT.test(slug)) {
    return {
      ok: false,
      code: "SLUG_INVALID",
      message:
        "A booking link may contain only lowercase letters, numbers and single hyphens.",
    };
  }

  return { ok: true, slug };
};

/*
 * The canonical public URL a consultant shares.
 *
 * Built from the frontend origin the orchestrator already knows,
 * so the consultant is never shown a link to the API host.
 */
export const buildDirectBookingUrl = ({
  origin,
  slug,
}: {
  origin: string;
  slug: string;
}): string =>
  `${origin.replace(/\/+$/, "")}/${slug}`;
