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
   * The hyphenated forms of routes already named above. These are
   * NOT redundant: the reserved set is matched after
   * normalization, and "privacy-policy" normalizes to itself, not
   * to "privacy". A page at /privacy-policy is a different route
   * from /privacy and needs its own entry.
   */
  "privacy-policy",
  "terms-of-service",
  "terms-and-conditions",
  "cookie-policy",
  "refund-policy",
  "sign-in",
  "sign-up",
  "log-in",
  "log-out",
  "reset-password",
  "forgot-password",
  "verify-email",
  "my-bookings",
  "not-found",
  "error",
  "health",

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

/*
 * DEFAULT SLUG GENERATION. PROJECT_LOCK Amendment 012.
 *
 * A consultant no longer chooses their own booking link — slugs are
 * admin-managed — so one has to be derived for them at activation.
 * It is derived from the name the platform already publishes, using
 * the SAME normalizer every other slug goes through, so a generated
 * link and an admin-entered one cannot follow different rules.
 *
 * There is no second name authority: display_name is the public
 * projection of profiles.full_name (Amendment 008), and the caller
 * falls back to the authoritative field only when the projection is
 * missing.
 *
 * Everything here is pure. Uniqueness is not a property of a name,
 * so it is settled by the caller against the database — and by the
 * unique index, which stays the final authority.
 */

/*
 * How many sequential suffixes to try before giving up on a
 * readable link.
 *
 * Twenty is far past any plausible number of consultants sharing a
 * name. Reaching it means something other than a name collision is
 * going on, and grinding through hundreds of round trips to prove
 * it would be worse than falling back.
 */
export const MAX_SLUG_ATTEMPTS = 20;

/*
 * Cut a base short enough that a suffix still fits inside the
 * database's sixty-character limit, and never leave it ending in a
 * hyphen — "john-smith-" + "-2" would be an invalid doubled hyphen.
 */
const truncateBase = (
  base: string,
  reserved: number,
): string =>
  base
    .slice(0, Math.max(1, SLUG_MAX_LENGTH - reserved))
    .replace(/-+$/, "");

/*
 * The base a name reduces to, or null when it reduces to nothing.
 *
 * "Abu Mansur Omar Sherrer" becomes abu-mansur-omar-sherrer.
 * "O'Brien" becomes o-brien — the apostrophe is punctuation, and a
 * run of punctuation is one hyphen. "Ålesund" becomes alesund,
 * because the normalizer decomposes and drops the ring rather than
 * treating the character as unprintable.
 *
 * Spaces become hyphens. Nothing is percent-encoded: this value
 * goes in a path segment that must be readable and typable.
 */
export const buildSlugBase = (
  name: string | null | undefined,
): string | null => {
  if (!name) {
    return null;
  }

  const base = truncateBase(
    normalizeSlug(name),
    0,
  );

  return base.length > 0 ? base : null;
};

/*
 * The nth candidate for a base.
 *
 * Attempt 1 is the bare base — john-smith. Attempt 2 is john-smith-2,
 * attempt 3 john-smith-3. Numbering starts at 2 because the first
 * consultant of that name holds the unsuffixed link, so "-1" would
 * name nobody.
 */
export const buildSlugCandidate = ({
  base,
  attempt,
}: {
  base: string;
  attempt: number;
}): string => {
  if (attempt <= 1) {
    return truncateBase(base, 0);
  }

  const suffix = `-${attempt}`;

  return `${truncateBase(base, suffix.length)}${suffix}`;
};

/*
 * The last resort, when twenty readable candidates were all taken
 * or refused.
 *
 * Short and unambiguous rather than long and random: six base-36
 * characters is about two billion possibilities, which is plenty
 * against a name collision and still a link somebody can read
 * aloud. The caller retries on a unique-violation regardless, so
 * this does not have to be collision-proof on its own.
 */
export const buildRandomSlugCandidate = ({
  base,
  random,
}: {
  base: string | null;
  random: string;
}): string => {
  const suffix = `-${random}`;

  /*
   * A consultant with no usable name at all still needs a link.
   * "consultant" alone is reserved; "consultant-a1b2c3" is not,
   * because the reserved set is matched exactly.
   */
  const usable = base ?? "consultant";

  return `${truncateBase(usable, suffix.length)}${suffix}`;
};

/*
 * The candidates to try, in order, for a generated default.
 *
 * A candidate that is reserved, too short, too long or malformed is
 * SKIPPED rather than returned — a consultant genuinely called
 * "Admin" gets admin-2, not a failed activation. This is the one
 * place suffixing is automatic; an admin entering a slug by hand is
 * told what is wrong and chooses again, because silently renaming
 * what somebody deliberately typed is worse than refusing it.
 */
export const buildDefaultSlugCandidates = (
  name: string | null | undefined,
): string[] => {
  const base = buildSlugBase(name);

  if (!base) {
    return [];
  }

  const candidates: string[] = [];

  for (
    let attempt = 1;
    attempt <= MAX_SLUG_ATTEMPTS;
    attempt += 1
  ) {
    const candidate = buildSlugCandidate({
      base,
      attempt,
    });

    const validation =
      validateConsultantSlug(candidate);

    if (validation.ok) {
      candidates.push(validation.slug);
    }
  }

  return candidates;
};
