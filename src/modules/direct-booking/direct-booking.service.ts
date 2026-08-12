import { env } from "../../config/env.js";
import { loadCountryIds } from "../consultant-profile/consultant-profile.repository.js";
import {
  getSettings,
  SettingsUnavailableError,
} from "../settings/settings.provider.js";
import {
  isSlugTakenByAnother,
  loadDirectBookingSettingsById,
  loadDirectBookingSettingsByProfileId,
  loadPublicConsultantBySlug,
  saveDirectBookingSettings,
  type ConsultantDirectBookingRow,
} from "./direct-booking.repository.js";
import {
  buildDirectBookingUrl,
  validateConsultantSlug,
} from "./direct-booking.slug.js";
import { DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS } from "./direct-booking.commission.js";

/*
 * Direct consultant booking. PROJECT_LOCK Amendment 011.
 *
 * A direct booking is an ORDINARY CONSULTATION taken through a
 * consultant's own page at their own price. Same table, same
 * statuses, same checkout, same double-booking protection. The only
 * differences are where the price comes from and how the money is
 * split, and both are settled on this side of the wire.
 */

/*
 * THE EFFECTIVE PRICE RULE, and it is the whole point of this file.
 *
 *   effective = max(configured, platform default)
 *
 * A consultant sets a price once. The platform's own consultation
 * price can rise afterwards, and when it does, a direct booking
 * priced below it would sell the platform's own product at a
 * discount through a page the platform hosts. So the floor moves
 * with the platform.
 *
 * The rule is applied in exactly two places and they must agree:
 * the public page's displayed price, and the price written onto
 * the draft consultation. That is why both come from this one
 * function rather than from two readings of the same column.
 *
 * Displaying the stored price while charging the effective one is
 * the specific failure this exists to prevent.
 */
export const resolveEffectiveDirectPrice = ({
  configuredPriceCents,
  platformPriceCents,
}: {
  configuredPriceCents: number | null;
  platformPriceCents: number;
}): number =>
  Math.max(
    configuredPriceCents ?? 0,
    platformPriceCents,
  );

export type PublicConsultantView = {
  consultant_id: string;
  consultant_slug: string;
  display_name: string | null;
  headline: string | null;
  bio: string | null;
  photo_url: string | null;
  timezone: string | null;
  gender: string | null;
  available_for_general: boolean;
  minimum_booking_notice_hours:
    | number
    | null;
  country_ids: string[];
  effective_direct_booking_price_cents: number;
  currency: string;
};

export type PublicConsultantResult =
  | {
      ok: true;
      consultant: PublicConsultantView;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    };

const NOT_FOUND_MESSAGE =
  "No booking page was found at that link.";

/*
 * The public booking page's read model.
 *
 * Unknown slug, deactivated consultant and switched-off page all
 * produce the SAME 404. A different answer for each would turn
 * this endpoint into a directory of who has a page and who has
 * been deactivated.
 *
 * What is returned is the safe projection and nothing else. No
 * commission rate, no payout method, no ledger, no email, no
 * profiles.full_name, no internal finance. Adding a field here is
 * a decision about what an anonymous visitor may see.
 */
export const getPublicConsultantBySlug =
  async (
    rawSlug: string,
  ): Promise<PublicConsultantResult> => {
    /*
     * The lookup key is the NORMALIZED slug, so /Aisha and /aisha
     * resolve to the same page and a reserved name never reaches
     * the database at all.
     */
    const validation =
      validateConsultantSlug(rawSlug);

    if (!validation.ok) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: NOT_FOUND_MESSAGE,
      };
    }

    let settings;

    try {
      settings = await getSettings();
    } catch (error) {
      console.error(
        "Public consultant page settings lookup failed",
        {
          message:
            error instanceof
            SettingsUnavailableError
              ? error.message
              : "Unknown settings error",
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The booking page could not be loaded.",
      };
    }

    const lookup =
      await loadPublicConsultantBySlug(
        validation.slug,
      );

    if (!lookup.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The booking page could not be loaded.",
      };
    }

    if (!lookup.data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: NOT_FOUND_MESSAGE,
      };
    }

    const consultant = lookup.data;

    const countries = await loadCountryIds(
      consultant.id,
    );

    return {
      ok: true,
      consultant: {
        consultant_id: consultant.id,
        consultant_slug:
          consultant.consultant_slug,
        display_name:
          consultant.display_name,
        headline: consultant.headline,
        bio: consultant.bio,
        photo_url: consultant.photo_url,
        timezone: consultant.timezone,
        gender: consultant.gender,
        available_for_general:
          consultant.available_for_general,
        minimum_booking_notice_hours:
          consultant.minimum_booking_notice_hours,
        country_ids: countries.ok
          ? countries.data
          : [],
        effective_direct_booking_price_cents:
          resolveEffectiveDirectPrice({
            configuredPriceCents:
              consultant.direct_booking_price_cents,
            platformPriceCents:
              settings.consultation_price_cents,
          }),
        currency:
          settings.consultation_currency,
      },
    };
  };

export type DirectBookingSettingsView = {
  consultant_id: string;
  consultant_slug: string | null;
  direct_booking_enabled: boolean;
  direct_booking_price_cents:
    | number
    | null;
  /*
   * Consultant-managed. When true the consultant is excluded from
   * the ordinary /consultation chooser and is bookable only through
   * their own link. Amendment 014.
   */
  direct_booking_only: boolean;
  effective_direct_booking_price_cents:
    | number
    | null;
  minimum_direct_booking_price_cents: number;
  /*
   * THE CALCULATOR TERMS, read-only everywhere. Amendment 014.
   *
   * Published so the consultant settings screen can show a
   * "price ↔ you earn" calculator without hardcoding percentages.
   * No PATCH accepts any of these three.
   *
   * standard_booking_price_cents is the SAME number as
   * minimum_direct_booking_price_cents above - one value answering
   * two questions, "the lowest price I may set" and "where my
   * premium starts". They are published separately because the
   * calculator asks the second question, and they must never be
   * allowed to diverge.
   *
   * The ledger remains authoritative for what is actually paid;
   * see direct-booking.commission.ts.
   */
  standard_booking_price_cents: number;
  base_consultant_commission_bps: number;
  premium_consultant_commission_bps: number;
  currency: string;
  booking_url: string | null;
};

const toSettingsView = ({
  row,
  platformPriceCents,
  baseCommissionBps,
  currency,
}: {
  row: ConsultantDirectBookingRow;
  platformPriceCents: number;
  baseCommissionBps: number;
  currency: string;
}): DirectBookingSettingsView => ({
  consultant_id: row.id,
  consultant_slug: row.consultant_slug,
  direct_booking_enabled:
    row.direct_booking_enabled,
  direct_booking_price_cents:
    row.direct_booking_price_cents,
  direct_booking_only:
    row.direct_booking_only,
  /*
   * Null until a price is configured. Reporting the platform
   * default as "your effective price" before a consultant has set
   * one would read as a price they had chosen.
   */
  effective_direct_booking_price_cents:
    row.direct_booking_price_cents === null
      ? null
      : resolveEffectiveDirectPrice({
          configuredPriceCents:
            row.direct_booking_price_cents,
          platformPriceCents,
        }),
  minimum_direct_booking_price_cents:
    platformPriceCents,
  standard_booking_price_cents:
    platformPriceCents,
  base_consultant_commission_bps:
    baseCommissionBps,
  premium_consultant_commission_bps:
    DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS,
  currency,
  booking_url: row.consultant_slug
    ? buildDirectBookingUrl({
        origin: env.APP_URL,
        slug: row.consultant_slug,
      })
    : null,
});

export type DirectBookingSettingsResult =
  | {
      ok: true;
      settings: DirectBookingSettingsView;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "VALIDATION_ERROR"
        | "CONFLICT"
        | "INTERNAL_ERROR";
      message: string;
      reason?: string;
    };

export const getOwnDirectBookingSettings =
  async (
    profileId: string,
  ): Promise<DirectBookingSettingsResult> => {
    let settings;

    try {
      settings = await getSettings();
    } catch {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "Your booking page settings could not be loaded.",
      };
    }

    const lookup =
      await loadDirectBookingSettingsByProfileId(
        profileId,
      );

    if (!lookup.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "Your booking page settings could not be loaded.",
      };
    }

    if (!lookup.data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "No consultant profile was found for this account.",
      };
    }

    return {
      ok: true,
      settings: toSettingsView({
        row: lookup.data,
        platformPriceCents:
          settings.consultation_price_cents,
        baseCommissionBps:
          settings.consultation_consultant_commission_bps,
        currency:
          settings.consultation_currency,
      }),
    };
  };

/*
 * WHO OWNS WHICH SETTING. PROJECT_LOCK Amendment 013.
 *
 * Three columns, three different answers, and the split is not
 * arbitrary:
 *
 *   consultant_slug          ADMIN writes, consultant reads.
 *                            A root URL in the platform's own
 *                            namespace, and a link that moves
 *                            breaks every card already carrying it.
 *
 *   direct_booking_enabled   ADMIN writes, consultant reads.
 *                            Publishing a page under the
 *                            platform's domain is a platform
 *                            decision, the same kind of decision
 *                            activation already is.
 *
 *   direct_booking_price_cents
 *                            CONSULTANT writes, admin reads.
 *                            What somebody charges for their own
 *                            time is theirs, and an admin who
 *                            could set it could set what a
 *                            consultant earns.
 *
 *   effective price          NOBODY writes. Derived by
 *                            resolveEffectiveDirectPrice above.
 *
 * The two entry points below are deliberately separate functions
 * with separate input types rather than one function taking an
 * actor. There is no object here that can carry "any direct
 * booking field", so a later edit cannot widen an actor's reach by
 * adding a property - it would have to add a parameter to a
 * function whose name says who is calling it.
 *
 * What they share is the VALIDATION, which is common to both and
 * lives in one place below. Ownership differs; the rules do not.
 */

export type ConsultantDirectBookingUpdate = {
  /*
   * Null clears a configured price, which is meaningful: it is how
   * a consultant withdraws a price they no longer want to offer.
   */
  direct_booking_price_cents?:
    | number
    | null;

  /*
   * "I only want direct bookings." Amendment 014.
   *
   * Consultant-managed because it is a statement about how they
   * want to work, not a platform decision. Deliberately NOT
   * refused when their direct page is off: they are then bookable
   * nowhere, which is a state they chose. Refusing it would let an
   * admin-owned setting block a consultant's own preference.
   */
  direct_booking_only?: boolean;
};

export type AdminDirectBookingUpdate = {
  consultant_slug?: string;
  direct_booking_enabled?: boolean;
};

type ResolvedUpdate = {
  slug: string | null;
  enabled: boolean;
  priceCents: number | null;
  directBookingOnly: boolean;
};

/*
 * Every rule that governs the three columns, in one place, applied
 * to the resolved next state regardless of who asked for it.
 *
 * Both actors run all of it. An admin enabling a page is held to
 * exactly the preconditions a consultant was held to when enabling
 * was theirs: the change of actor is a change of authority, not a
 * relaxation of the rules.
 */
const validateResolvedUpdate = ({
  current,
  next,
  platformPriceCents,
}: {
  current: ConsultantDirectBookingRow;
  next: ResolvedUpdate;
  platformPriceCents: number;
}):
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR" | "CONFLICT";
      message: string;
      reason: string;
    } => {
  /*
   * The price floor, checked AT SAVE TIME against the platform's
   * current price.
   *
   * Deliberately not a database constraint: the platform default
   * may later rise above a stored price, and a constraint would
   * then invalidate an untouched row and block every unrelated
   * update to it. The effective price rule is what keeps that safe
   * afterwards - a stale low price is charged at the platform
   * default rather than below it.
   */
  if (
    next.priceCents !== null &&
    next.priceCents < platformPriceCents
  ) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: `The price must be at least the standard consultation price of ${platformPriceCents} minor units.`,
      reason: "PRICE_BELOW_PLATFORM_MINIMUM",
    };
  }

  /*
   * Publishing requires a URL to publish at and a price to charge.
   * The database says the same thing; saying it here turns a
   * constraint violation into a sentence.
   *
   * Note there is no separate "effective price is at least the
   * platform minimum" check, and none is needed: the effective
   * price is max(configured, platform), so it is at or above the
   * minimum by construction. Adding a refusal for a case that
   * cannot arise would be dead code, and it would wrongly block an
   * admin from enabling a consultant whose stored price simply
   * predates a price rise - which the effective price rule already
   * handles by charging the higher figure.
   */
  /*
   * An inactive consultant cannot be published. Activation is a
   * separate administrative decision with its own completeness
   * rules, and a live booking page for somebody who has not passed
   * them is a public listing the platform never approved.
   *
   * Checked BEFORE the slug and price preconditions because it is
   * the one that cannot be worked around: telling an admin to set
   * a price for a consultant who cannot be published either way
   * sends them to fix the wrong thing.
   */
  if (next.enabled && !current.is_active) {
    return {
      ok: false,
      code: "CONFLICT",
      message:
        "The consultant must be active before their booking page can go live.",
      reason: "CONSULTANT_NOT_ACTIVE",
    };
  }

  if (next.enabled && !next.slug) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message:
        "A booking link is required before the booking page can go live.",
      reason: "SLUG_REQUIRED",
    };
  }

  if (next.enabled && next.priceCents === null) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message:
        "A price is required before the booking page can go live.",
      reason: "PRICE_REQUIRED",
    };
  }

  return { ok: true };
};

/*
 * The one write. Both entry points resolve their own actor's
 * fields, then hand the complete next state here.
 */
const saveResolvedUpdate = async ({
  current,
  next,
  platformPriceCents,
  baseCommissionBps,
  currency,
  failureMessage,
}: {
  current: ConsultantDirectBookingRow;
  next: ResolvedUpdate;
  platformPriceCents: number;
  baseCommissionBps: number;
  currency: string;
  failureMessage: string;
}): Promise<DirectBookingSettingsResult> => {
  const validation = validateResolvedUpdate({
    current,
    next,
    platformPriceCents,
  });

  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      message: validation.message,
      reason: validation.reason,
    };
  }

  const saved = await saveDirectBookingSettings({
    consultantId: current.id,
    slug: next.slug,
    enabled: next.enabled,
    priceCents: next.priceCents,
    directBookingOnly: next.directBookingOnly,
  });

  if (!saved.ok) {
    if (saved.code === "SLUG_TAKEN") {
      /*
       * Claimed between the availability check and this write. The
       * unique index is the referee; a raw 23505 never reaches
       * HTTP.
       */
      return {
        ok: false,
        code: "CONFLICT",
        message:
          "That booking link is already taken. Please choose another.",
        reason: "SLUG_TAKEN",
      };
    }

    if (saved.code === "CONSTRAINT_VIOLATION") {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "Those booking page settings are not valid.",
        reason: "SLUG_INVALID",
      };
    }

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: failureMessage,
    };
  }

  return {
    ok: true,
    settings: toSettingsView({
      row: saved.row,
      platformPriceCents,
      baseCommissionBps,
      currency,
    }),
  };
};

/*
 * A consultant sets their own price. That is the whole of their
 * write surface.
 *
 * The consultant row is resolved from the profile id on the
 * verified access token, so there is no identifier to tamper with
 * - one consultant cannot address another's settings even by
 * guessing a uuid.
 *
 * The slug and the enabled flag are carried forward from the
 * stored row untouched. The request schema refuses both outright,
 * so this is the second line rather than the first.
 */
export const updateOwnDirectBookingSettings =
  async ({
    profileId,
    input,
  }: {
    profileId: string;
    input: ConsultantDirectBookingUpdate;
  }): Promise<DirectBookingSettingsResult> => {
    const failureMessage =
      "Your booking page settings could not be saved.";

    let settings;

    try {
      settings = await getSettings();
    } catch {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message: failureMessage,
      };
    }

    const lookup =
      await loadDirectBookingSettingsByProfileId(
        profileId,
      );

    if (!lookup.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message: failureMessage,
      };
    }

    if (!lookup.data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "No consultant profile was found for this account.",
      };
    }

    const current = lookup.data;

    return saveResolvedUpdate({
      current,
      next: {
        /* Not theirs. Carried through, never read from input. */
        slug: current.consultant_slug,
        enabled: current.direct_booking_enabled,
        /* Absent keeps the stored value; this is a PATCH. */
        priceCents:
          input.direct_booking_price_cents ===
          undefined
            ? current.direct_booking_price_cents
            : input.direct_booking_price_cents,
        directBookingOnly:
          input.direct_booking_only ??
          current.direct_booking_only,
      },
      platformPriceCents:
        settings.consultation_price_cents,
      baseCommissionBps:
        settings.consultation_consultant_commission_bps,
      currency:
        settings.consultation_currency,
      failureMessage,
    });
  };

export const getAdminDirectBookingSettings =
  async (
    consultantId: string,
  ): Promise<DirectBookingSettingsResult> => {
    let settings;

    try {
      settings = await getSettings();
    } catch {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant's booking page could not be loaded.",
      };
    }

    const lookup =
      await loadDirectBookingSettingsById(
        consultantId,
      );

    if (!lookup.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant's booking page could not be loaded.",
      };
    }

    if (!lookup.data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "The consultant was not found.",
      };
    }

    return {
      ok: true,
      settings: toSettingsView({
        row: lookup.data,
        platformPriceCents:
          settings.consultation_price_cents,
        baseCommissionBps:
          settings.consultation_consultant_commission_bps,
        currency:
          settings.consultation_currency,
      }),
    };
  };

/*
 * An administrator sets a consultant's booking link.
 *
 * The ONLY path that writes a hand-entered slug. It runs the same
 * validation a generated one runs — normalize, reserved, format,
 * length, uniqueness — because a second implementation is a second
 * set of rules waiting to disagree.
 *
 * It deliberately does NOT suffix. Generation may quietly turn
 * john-smith into john-smith-2 because nobody asked for that exact
 * string; an administrator typed this one, and silently storing
 * something else would be worse than saying it is taken.
 */
/*
 * An administrator sets the booking link and decides whether the
 * page is live. Those two, and nothing else.
 *
 * The PRICE IS NOT HERE and is not a parameter. An admin who could
 * set a consultant's price could set what that consultant earns,
 * and the effective price rule means it would also change what a
 * client is charged. It is carried through from the stored row.
 *
 * Slug changes do NOT suffix. A generated default may quietly
 * become john-smith-2 because nobody asked for that exact string;
 * an administrator typed this one, so a collision is refused
 * rather than silently renamed.
 */
export const updateDirectBookingAsAdmin =
  async ({
    consultantId,
    input,
  }: {
    consultantId: string;
    input: AdminDirectBookingUpdate;
  }): Promise<DirectBookingSettingsResult> => {
    const failureMessage =
      "The booking page settings could not be saved.";

    let settings;

    try {
      settings = await getSettings();
    } catch {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message: failureMessage,
      };
    }

    const lookup =
      await loadDirectBookingSettingsById(
        consultantId,
      );

    if (!lookup.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message: failureMessage,
      };
    }

    if (!lookup.data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "The consultant was not found.",
      };
    }

    const current = lookup.data;

    let nextSlug = current.consultant_slug;

    if (input.consultant_slug !== undefined) {
      const validation =
        validateConsultantSlug(
          input.consultant_slug,
        );

      if (!validation.ok) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: validation.message,
          reason: validation.code,
        };
      }

      nextSlug = validation.slug;

      const taken = await isSlugTakenByAnother({
        slug: nextSlug,
        consultantId: current.id,
      });

      if (!taken.ok) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message: failureMessage,
        };
      }

      if (taken.data) {
        return {
          ok: false,
          code: "CONFLICT",
          message:
            "That booking link is already taken. Please choose another.",
          reason: "SLUG_TAKEN",
        };
      }
    }

    return saveResolvedUpdate({
      current,
      next: {
        slug: nextSlug,
        enabled:
          input.direct_booking_enabled ??
          current.direct_booking_enabled,
        /*
         * Not theirs. Carried through, never read from input -
         * AdminDirectBookingUpdate has neither a price nor a
         * direct-booking-only field at all.
         */
        priceCents:
          current.direct_booking_price_cents,
        directBookingOnly:
          current.direct_booking_only,
      },
      platformPriceCents:
        settings.consultation_price_cents,
      baseCommissionBps:
        settings.consultation_consultant_commission_bps,
      currency:
        settings.consultation_currency,
      failureMessage,
    });
  };

/*
 * The dedicated disable action, kept as its own endpoint because
 * it is the moderation gesture an admin reaches for and it should
 * not require constructing a body.
 *
 * Delegates rather than duplicating. Disabling leaves the slug and
 * the price exactly as they are: the link stays reserved for that
 * consultant so re-enabling restores the same URL rather than
 * freeing it for somebody else, and the price stays stored so they
 * do not have to set it again.
 */
export const disableDirectBookingAsAdmin =
  async (
    consultantId: string,
  ): Promise<DirectBookingSettingsResult> =>
    updateDirectBookingAsAdmin({
      consultantId,
      input: { direct_booking_enabled: false },
    });
