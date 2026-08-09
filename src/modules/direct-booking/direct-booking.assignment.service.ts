import { randomBytes } from "node:crypto";
import {
  claimGeneratedSlug,
  isSlugTakenByAnother,
  listActiveConsultantsWithoutSlug,
  loadConsultantNameForSlug,
} from "./direct-booking.repository.js";
import {
  buildDefaultSlugCandidates,
  buildRandomSlugCandidate,
  buildSlugBase,
  MAX_SLUG_ATTEMPTS,
  validateConsultantSlug,
} from "./direct-booking.slug.js";

/*
 * Assigning a consultant their default booking link.
 * PROJECT_LOCK Amendment 012.
 *
 * Consultants no longer choose their own slug — it is admin-managed
 * — so one is derived for them at activation, from the name the
 * platform already publishes, through the same normalizer every
 * other slug goes through.
 *
 * TWO RULES GOVERN EVERYTHING HERE:
 *
 *   A slug is assigned only when there is none. Never overwritten,
 *   not at activation, not on a rename, not by a rerun of the
 *   backfill. Once a link exists it is stable until an admin
 *   changes it deliberately, because a link that moves on its own
 *   is a link nobody can share.
 *
 *   Generated defaults may SUFFIX; admin-entered slugs may not. A
 *   consultant called John Smith who arrives second becomes
 *   john-smith-2 without anybody being asked. An admin who types a
 *   taken slug is told so and picks another, because silently
 *   renaming what somebody deliberately typed is worse than
 *   refusing it.
 */

export type AssignSlugResult =
  | {
      ok: true;
      slug: string;
      /*
       * False when the consultant already had one. The caller
       * should not log an assignment that did not happen.
       */
      assigned: boolean;
    }
  | {
      ok: false;
      code:
        | "CONSULTANT_NOT_FOUND"
        | "NO_USABLE_NAME"
        | "SLUG_EXHAUSTED"
        | "INTERNAL_ERROR";
      message: string;
    };

/*
 * Six base-36 characters. Not a security value — it is the tail of
 * a public URL — so a readable length beats an unguessable one, and
 * the unique index catches the rest.
 */
const randomSuffix = (): string =>
  randomBytes(4)
    .toString("hex")
    .slice(0, 6);

/*
 * Try one candidate: check availability, then claim it.
 *
 * Both steps are needed and neither is sufficient. The check turns
 * the ordinary collision into a cheap skip; the claim is guarded by
 * the unique index, which is what makes a race between two
 * activations safe rather than merely unlikely.
 */
const tryClaim = async ({
  consultantId,
  slug,
}: {
  consultantId: string;
  slug: string;
}): Promise<"claimed" | "taken" | "failed"> => {
  const taken = await isSlugTakenByAnother({
    slug,
    consultantId,
  });

  if (!taken.ok) {
    return "failed";
  }

  if (taken.data) {
    return "taken";
  }

  const claim = await claimGeneratedSlug({
    consultantId,
    slug,
  });

  if (claim.ok) {
    return "claimed";
  }

  return claim.code === "SLUG_TAKEN"
    ? "taken"
    : "failed";
};

/*
 * Give a consultant a booking link if they do not have one.
 *
 * Returns the existing slug untouched when there is one, which is
 * what makes this safe to call on every activation and safe to
 * rerun from the backfill.
 */
export const assignDefaultSlugIfMissing =
  async ({
    consultantId,
    existingSlug,
    displayName,
  }: {
    consultantId: string;
    /*
     * Passed when the caller has already read the row, so an
     * activation does not re-read it. Undefined means "look it
     * up".
     */
    existingSlug?: string | null;
    displayName?: string | null;
  }): Promise<AssignSlugResult> => {
    if (existingSlug) {
      return {
        ok: true,
        slug: existingSlug,
        assigned: false,
      };
    }

    let name: string | null =
      displayName ?? null;

    /*
     * The row is read unless the caller has already established
     * BOTH that there is no slug and what the name is. Reading it
     * here is what lets a caller pass nothing at all and still be
     * safe - the stored slug is the authority on whether one
     * exists, not the caller's belief about it.
     */
    if (existingSlug === undefined || !name) {
      const lookup =
        await loadConsultantNameForSlug(
          consultantId,
        );

      if (!lookup.ok) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The consultant's booking link could not be generated.",
        };
      }

      if (!lookup.data) {
        return {
          ok: false,
          code: "CONSULTANT_NOT_FOUND",
          message:
            "The consultant was not found.",
        };
      }

      if (lookup.data.consultantSlug) {
        return {
          ok: true,
          slug: lookup.data.consultantSlug,
          assigned: false,
        };
      }

      /*
       * display_name is the public projection of
       * profiles.full_name. The authoritative field is the
       * fallback, not a second source: it is read only when the
       * projection is missing.
       */
      name =
        name ??
        lookup.data.displayName ??
        lookup.data.fullName;
    }

    const base = buildSlugBase(name);

    if (!base) {
      return {
        ok: false,
        code: "NO_USABLE_NAME",
        message:
          "The consultant has no name a booking link can be built from.",
      };
    }

    /*
     * Readable candidates first: the bare name, then -2, -3 and so
     * on. A candidate that is reserved or malformed is skipped
     * rather than refused, so a consultant genuinely called "Admin"
     * gets admin-2 instead of a failed activation.
     */
    for (const candidate of buildDefaultSlugCandidates(
      name,
    )) {
      const outcome = await tryClaim({
        consultantId,
        slug: candidate,
      });

      if (outcome === "claimed") {
        return {
          ok: true,
          slug: candidate,
          assigned: true,
        };
      }

      if (outcome === "failed") {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The consultant's booking link could not be generated.",
        };
      }
    }

    /*
     * Twenty readable candidates were all taken. Something other
     * than a name collision is going on, so stop grinding through
     * round trips and fall back to a short random tail.
     */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate =
        buildRandomSlugCandidate({
          base,
          random: randomSuffix(),
        });

      /* Belt and braces: a random tail cannot make it reserved. */
      const validation =
        validateConsultantSlug(candidate);

      if (!validation.ok) {
        continue;
      }

      const outcome = await tryClaim({
        consultantId,
        slug: validation.slug,
      });

      if (outcome === "claimed") {
        return {
          ok: true,
          slug: validation.slug,
          assigned: true,
        };
      }

      if (outcome === "failed") {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The consultant's booking link could not be generated.",
        };
      }
    }

    console.error(
      "Consultant slug generation exhausted every candidate",
      {
        consultantId,
        base,
        attempts: MAX_SLUG_ATTEMPTS + 5,
      },
    );

    return {
      ok: false,
      code: "SLUG_EXHAUSTED",
      message:
        "A booking link could not be generated for this consultant.",
    };
  };

export type BackfillOutcome = {
  consultantId: string;
  slug: string | null;
  status: "assigned" | "skipped" | "failed";
  reason: string | null;
};

export type BackfillResult =
  | {
      ok: true;
      outcomes: BackfillOutcome[];
    }
  | {
      ok: false;
      message: string;
    };

/*
 * Give every active consultant who has no booking link one.
 *
 * Idempotent by construction rather than by a flag: the listing
 * selects only null slugs, and the claim itself refuses to
 * overwrite. A second run finds nothing and changes nothing.
 *
 * Deliberately does NOT enable direct booking. A link is an
 * address, not a decision to publish; switching a consultant's page
 * on is theirs to make.
 */
export const backfillConsultantSlugs =
  async (): Promise<BackfillResult> => {
    const listing =
      await listActiveConsultantsWithoutSlug();

    if (!listing.ok) {
      return {
        ok: false,
        message:
          "The consultants needing a booking link could not be listed.",
      };
    }

    const outcomes: BackfillOutcome[] = [];

    for (const consultant of listing.data) {
      const result =
        await assignDefaultSlugIfMissing({
          consultantId: consultant.id,
          displayName:
            consultant.displayName,
        });

      if (result.ok) {
        outcomes.push({
          consultantId: consultant.id,
          slug: result.slug,
          status: result.assigned
            ? "assigned"
            : "skipped",
          reason: result.assigned
            ? null
            : "already_had_a_slug",
        });

        continue;
      }

      /*
       * One consultant failing does not stop the rest. A run that
       * abandoned everything because of one nameless row would
       * have to be restarted by hand, and the failures are
       * reported at the end either way.
       */
      outcomes.push({
        consultantId: consultant.id,
        slug: null,
        status: "failed",
        reason: result.code,
      });
    }

    return { ok: true, outcomes };
  };
