import { env } from "../../config/env.js";
import { loadCountryIds } from "../consultant-profile/consultant-profile.repository.js";
import {
  getSettings,
  SettingsUnavailableError,
} from "../settings/settings.provider.js";
import {
  adminDisableDirectBooking,
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
  effective_direct_booking_price_cents:
    | number
    | null;
  minimum_direct_booking_price_cents: number;
  currency: string;
  booking_url: string | null;
};

const toSettingsView = ({
  row,
  platformPriceCents,
  currency,
}: {
  row: ConsultantDirectBookingRow;
  platformPriceCents: number;
  currency: string;
}): DirectBookingSettingsView => ({
  consultant_id: row.id,
  consultant_slug: row.consultant_slug,
  direct_booking_enabled:
    row.direct_booking_enabled,
  direct_booking_price_cents:
    row.direct_booking_price_cents,
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
        currency:
          settings.consultation_currency,
      }),
    };
  };

export type UpdateDirectBookingInput = {
  consultant_slug?: string | null;
  direct_booking_enabled?: boolean;
  direct_booking_price_cents?:
    | number
    | null;
};

/*
 * A consultant edits THEIR OWN page.
 *
 * The consultant row is resolved from the profile id on the
 * verified token. No consultant id is accepted from the request,
 * so there is no identifier to tamper with — one consultant cannot
 * address another's settings even by guessing a uuid.
 *
 * Note what this function will not write: no commission
 * percentage, no split, no earnings figure. Those are not fields
 * on this shape and are not columns a consultant may set. The 50/50
 * base and the 80/20 premium are platform rules.
 */
export const updateOwnDirectBookingSettings =
  async ({
    profileId,
    input,
  }: {
    profileId: string;
    input: UpdateDirectBookingInput;
  }): Promise<DirectBookingSettingsResult> => {
    let settings;

    try {
      settings = await getSettings();
    } catch {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "Your booking page settings could not be saved.",
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
          "Your booking page settings could not be saved.",
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

    /* Absent fields keep their stored value; this is a PATCH. */
    const nextEnabled =
      input.direct_booking_enabled ??
      current.direct_booking_enabled;

    const nextPrice =
      input.direct_booking_price_cents ===
      undefined
        ? current.direct_booking_price_cents
        : input.direct_booking_price_cents;

    let nextSlug =
      input.consultant_slug === undefined
        ? current.consultant_slug
        : input.consultant_slug;

    if (
      input.consultant_slug !== undefined &&
      input.consultant_slug !== null
    ) {
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

      const taken =
        await isSlugTakenByAnother({
          slug: nextSlug,
          consultantId: current.id,
        });

      if (!taken.ok) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "Your booking page settings could not be saved.",
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

    /*
     * The price floor, checked AT SAVE TIME against the platform's
     * current price.
     *
     * Deliberately not a database constraint: the platform default
     * may later rise above a stored price, and a constraint would
     * then invalidate an untouched row and block every unrelated
     * update to it. The effective price rule is what keeps that
     * safe afterwards — a stale low price is charged at the
     * platform default rather than below it.
     */
    if (
      nextPrice !== null &&
      nextPrice <
        settings.consultation_price_cents
    ) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: `Your price must be at least the standard consultation price of ${settings.consultation_price_cents} minor units.`,
        reason: "PRICE_BELOW_PLATFORM_MINIMUM",
      };
    }

    /*
     * Publishing requires a URL to publish at and a price to
     * charge. The database says the same thing; saying it here
     * turns a constraint violation into a sentence.
     */
    if (nextEnabled && !nextSlug) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "Choose a booking link before turning your booking page on.",
        reason: "SLUG_REQUIRED",
      };
    }

    if (nextEnabled && nextPrice === null) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "Set your price before turning your booking page on.",
        reason: "PRICE_REQUIRED",
      };
    }

    /*
     * An inactive consultant cannot publish. Activation is the
     * admin's decision and a booking page is a public listing; a
     * consultant who has not been activated must not be able to
     * create one for themselves.
     */
    if (nextEnabled && !current.is_active) {
      return {
        ok: false,
        code: "CONFLICT",
        message:
          "Your profile must be active before your booking page can go live.",
        reason: "CONSULTANT_NOT_ACTIVE",
      };
    }

    const saved =
      await saveDirectBookingSettings({
        consultantId: current.id,
        slug: nextSlug,
        enabled: nextEnabled,
        priceCents: nextPrice,
      });

    if (!saved.ok) {
      if (saved.code === "SLUG_TAKEN") {
        return {
          ok: false,
          code: "CONFLICT",
          message:
            "That booking link is already taken. Please choose another.",
          reason: "SLUG_TAKEN",
        };
      }

      if (
        saved.code ===
        "CONSTRAINT_VIOLATION"
      ) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message:
            "Those booking page settings are not valid.",
        };
      }

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "Your booking page settings could not be saved.",
      };
    }

    return {
      ok: true,
      settings: toSettingsView({
        row: saved.row,
        platformPriceCents:
          settings.consultation_price_cents,
        currency:
          settings.consultation_currency,
      }),
    };
  };

/*
 * The admin read and the admin action.
 *
 * An admin sees the enabled flag, the slug, the configured price
 * and the effective price — enough to answer "what is this
 * consultant charging, and is that what the client is quoted?" —
 * and can switch the page off. Nothing else.
 */
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
        currency:
          settings.consultation_currency,
      }),
    };
  };

export const disableDirectBookingAsAdmin =
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
          "The booking page could not be disabled.",
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
          "The booking page could not be disabled.",
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

    const disabled =
      await adminDisableDirectBooking(
        consultantId,
      );

    if (!disabled.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The booking page could not be disabled.",
      };
    }

    return {
      ok: true,
      settings: toSettingsView({
        row: disabled.row,
        platformPriceCents:
          settings.consultation_price_cents,
        currency:
          settings.consultation_currency,
      }),
    };
  };
