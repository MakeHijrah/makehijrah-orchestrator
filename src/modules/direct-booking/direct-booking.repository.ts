import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Direct consultant booking reads and writes. Amendment 011.
 *
 * Everything here goes through the service role. anon does hold a
 * SELECT policy on active consultants — that predates this feature
 * and serves the generic booking flow — but the public booking
 * page is NOT served from it. Two reasons, and the second is the
 * one that matters:
 *
 *   1. The policy is a ROW policy, so a direct table read hands a
 *      visitor every column, including ones the public page has no
 *      business seeing.
 *
 *   2. direct_booking_price_cents is the CONFIGURED price, and the
 *      configured price is not necessarily the price charged. The
 *      effective price is max(configured, platform default), and a
 *      page that displayed the stored figure while checkout
 *      charged the effective one would quote a client one number
 *      and take another.
 *
 * So the projection is built here, on the server, and the
 * effective price is computed here. See direct-booking.service.
 */

export type PublicConsultantRow = {
  id: string;
  consultant_slug: string;
  display_name: string | null;
  headline: string | null;
  bio: string | null;
  photo_url: string | null;
  timezone: string | null;
  gender: string | null;
  available_for_general: boolean;
  minimum_booking_notice_hours: number | null;
  direct_booking_price_cents: number | null;
};

/*
 * The safe projection, named explicitly rather than selected with
 * a wildcard.
 *
 * Never add to this list without asking whether an anonymous
 * visitor should see it. profile_id is absent on purpose: it is
 * the join key to profiles, which carries the consultant's legal
 * name and email.
 */
const PUBLIC_CONSULTANT_COLUMNS = [
  "id",
  "consultant_slug",
  "display_name",
  "headline",
  "bio",
  "photo_url",
  "timezone",
  "gender",
  "available_for_general",
  "minimum_booking_notice_hours",
  "direct_booking_price_cents",
].join(", ");

export type RepositoryResult<T> =
  | { ok: true; data: T }
  | { ok: false };

/*
 * Resolve a slug to a PUBLISHED consultant.
 *
 * Both gates are applied in the query, not by the caller: a
 * deactivated consultant and a consultant who has switched direct
 * booking off are equally invisible, and neither is
 * distinguishable from a slug that never existed. The route turns
 * every one of those into the same 404.
 */
export const loadPublicConsultantBySlug =
  async (
    slug: string,
  ): Promise<
    RepositoryResult<PublicConsultantRow | null>
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .select(
          PUBLIC_CONSULTANT_COLUMNS,
        )
        .eq("consultant_slug", slug)
        .eq("is_active", true)
        .eq(
          "direct_booking_enabled",
          true,
        )
        .maybeSingle();

    if (error) {
      console.error(
        "Public consultant slug lookup failed",
        {
          slug,
          code: error.code,
          message: error.message,
        },
      );

      return { ok: false };
    }

    return {
      ok: true,
      data:
        (data as PublicConsultantRow | null) ??
        null,
    };
  };

export type ConsultantDirectBookingRow = {
  id: string;
  profile_id: string;
  is_active: boolean;
  consultant_slug: string | null;
  direct_booking_enabled: boolean;
  direct_booking_price_cents: number | null;
};

const SETTINGS_COLUMNS = [
  "id",
  "profile_id",
  "is_active",
  "consultant_slug",
  "direct_booking_enabled",
  "direct_booking_price_cents",
].join(", ");

/*
 * A consultant's own row, found by their profile id.
 *
 * The profile id comes from the verified access token and is never
 * accepted from the request body, which is what makes "own
 * settings only" structural rather than a check that could be
 * forgotten.
 */
export const loadDirectBookingSettingsByProfileId =
  async (
    profileId: string,
  ): Promise<
    RepositoryResult<ConsultantDirectBookingRow | null>
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .select(SETTINGS_COLUMNS)
        .eq("profile_id", profileId)
        .maybeSingle();

    if (error) {
      console.error(
        "Consultant direct booking settings lookup failed",
        {
          profileId,
          code: error.code,
          message: error.message,
        },
      );

      return { ok: false };
    }

    return {
      ok: true,
      data:
        (data as ConsultantDirectBookingRow | null) ??
        null,
    };
  };

export const loadDirectBookingSettingsById =
  async (
    consultantId: string,
  ): Promise<
    RepositoryResult<ConsultantDirectBookingRow | null>
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .select(SETTINGS_COLUMNS)
        .eq("id", consultantId)
        .maybeSingle();

    if (error) {
      console.error(
        "Consultant direct booking lookup by id failed",
        {
          consultantId,
          code: error.code,
          message: error.message,
        },
      );

      return { ok: false };
    }

    return {
      ok: true,
      data:
        (data as ConsultantDirectBookingRow | null) ??
        null,
    };
  };

/*
 * Is this slug already somebody else's?
 *
 * An advisory check. The unique index is the referee and the save
 * below still handles 23505 — this exists so the ordinary case
 * produces a precise message instead of a database error code.
 */
export const isSlugTakenByAnother = async ({
  slug,
  consultantId,
}: {
  slug: string;
  consultantId: string;
}): Promise<
  RepositoryResult<boolean>
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultants")
      .select("id")
      .eq("consultant_slug", slug)
      .neq("id", consultantId)
      .limit(1);

  if (error) {
    console.error(
      "Consultant slug availability check failed",
      {
        code: error.code,
        message: error.message,
      },
    );

    return { ok: false };
  }

  return {
    ok: true,
    data: (data ?? []).length > 0,
  };
};

export type SaveDirectBookingResult =
  | {
      ok: true;
      row: ConsultantDirectBookingRow;
    }
  | {
      ok: false;
      code:
        | "SLUG_TAKEN"
        | "CONSTRAINT_VIOLATION"
        | "INTERNAL_ERROR";
    };

/*
 * Write the three columns and read back what was stored.
 *
 * The update is keyed on the consultant id the caller already
 * resolved from their own token. A 23505 is the unique slug index
 * and means somebody claimed the slug between the advisory check
 * and this write; a 23514 is one of the migration's CHECK
 * constraints, which the API's own validation should already have
 * caught.
 */
export const saveDirectBookingSettings =
  async ({
    consultantId,
    slug,
    enabled,
    priceCents,
  }: {
    consultantId: string;
    slug: string | null;
    enabled: boolean;
    priceCents: number | null;
  }): Promise<SaveDirectBookingResult> => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .update({
          consultant_slug: slug,
          direct_booking_enabled: enabled,
          direct_booking_price_cents:
            priceCents,
        })
        .eq("id", consultantId)
        .select(SETTINGS_COLUMNS)
        .maybeSingle();

    if (error) {
      if (error.code === "23505") {
        return {
          ok: false,
          code: "SLUG_TAKEN",
        };
      }

      if (error.code === "23514") {
        console.error(
          "Direct booking settings violated a database constraint",
          {
            consultantId,
            message: error.message,
          },
        );

        return {
          ok: false,
          code: "CONSTRAINT_VIOLATION",
        };
      }

      console.error(
        "Direct booking settings save failed",
        {
          consultantId,
          code: error.code,
          message: error.message,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
      };
    }

    const row =
      data as ConsultantDirectBookingRow | null;

    if (!row) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
      };
    }

    return { ok: true, row };
  };

/*
 * The admin's one write: switch a consultant's page off.
 *
 * Deliberately narrow. An admin does not rename a consultant's
 * booking link and does not set their price — those are the
 * consultant's, and an admin who could change them could change
 * what a consultant earns. Disabling is the moderation action, and
 * it is reversible by the consultant.
 *
 * The slug and the price are left exactly as they are, so
 * re-enabling restores the same URL rather than freeing it for
 * somebody else to claim.
 */
export const adminDisableDirectBooking =
  async (
    consultantId: string,
  ): Promise<SaveDirectBookingResult> => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .update({
          direct_booking_enabled: false,
        })
        .eq("id", consultantId)
        .select(SETTINGS_COLUMNS)
        .maybeSingle();

    if (error) {
      console.error(
        "Admin direct booking disable failed",
        {
          consultantId,
          code: error.code,
          message: error.message,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
      };
    }

    const row =
      data as ConsultantDirectBookingRow | null;

    if (!row) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
      };
    }

    return { ok: true, row };
  };


/*
 * The name a default slug is derived from.
 *
 * consultants.display_name is the public projection of
 * profiles.full_name (Amendment 008) and is what every public
 * surface already renders, so it is the source. profiles.full_name
 * is read only when the projection is missing — a consultant
 * activated before migration 030's backfill, or one whose name was
 * never projected. There is no third name and no second authority.
 */
export const loadConsultantNameForSlug =
  async (
    consultantId: string,
  ): Promise<
    RepositoryResult<{
      displayName: string | null;
      fullName: string | null;
      consultantSlug: string | null;
    } | null>
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .select(
          "id, display_name, profile_id, consultant_slug",
        )
        .eq("id", consultantId)
        .maybeSingle();

    if (error) {
      console.error(
        "Consultant name lookup for slug generation failed",
        {
          consultantId,
          code: error.code,
          message: error.message,
        },
      );

      return { ok: false };
    }

    const row = data as {
      id: string;
      display_name: string | null;
      profile_id: string;
      consultant_slug: string | null;
    } | null;

    if (!row) {
      return { ok: true, data: null };
    }

    /*
     * Only reached when the projection is empty, so an ordinary
     * activation costs one query rather than two.
     */
    if (row.display_name) {
      return {
        ok: true,
        data: {
          displayName: row.display_name,
          fullName: null,
          consultantSlug:
            row.consultant_slug,
        },
      };
    }

    const { data: profileData, error: profileError } =
      await supabaseAdmin
        .from("profiles")
        .select("full_name")
        .eq("id", row.profile_id)
        .maybeSingle();

    if (profileError) {
      console.error(
        "Consultant profile name lookup for slug generation failed",
        {
          consultantId,
          code: profileError.code,
          message: profileError.message,
        },
      );

      return { ok: false };
    }

    return {
      ok: true,
      data: {
        displayName: null,
        fullName:
          (profileData as {
            full_name: string | null;
          } | null)?.full_name ?? null,
        consultantSlug: row.consultant_slug,
      },
    };
  };

export type ClaimSlugResult =
  | { ok: true; claimed: true }
  | { ok: false; code: "SLUG_TAKEN" | "INTERNAL_ERROR" };

/*
 * Claim a slug for a consultant that does not have one.
 *
 * The `is` filter on consultant_slug is what makes this safe to
 * call concurrently and safe to rerun: a consultant who already has
 * a slug matches nothing, so an existing link can never be
 * overwritten by generation — not by a racing activation, not by a
 * second run of the backfill, not by a mistaken call.
 *
 * A 23505 means another consultant took the candidate between the
 * availability check and this write. The caller moves to the next
 * candidate; the unique index remains the final authority on who
 * holds a link.
 */
export const claimGeneratedSlug = async ({
  consultantId,
  slug,
}: {
  consultantId: string;
  slug: string;
}): Promise<ClaimSlugResult> => {
  const { data, error } = await supabaseAdmin
    .from("consultants")
    .update({ consultant_slug: slug })
    .eq("id", consultantId)
    .is("consultant_slug", null)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, code: "SLUG_TAKEN" };
    }

    console.error(
      "Consultant slug claim failed",
      {
        consultantId,
        slug,
        code: error.code,
        message: error.message,
      },
    );

    return { ok: false, code: "INTERNAL_ERROR" };
  }

  if (!data) {
    /*
     * No row matched, which means the consultant already holds a
     * slug. Not an error and not a claim: generation never
     * overwrites.
     */
    return { ok: false, code: "INTERNAL_ERROR" };
  }

  return { ok: true, claimed: true };
};

/*
 * Every active consultant still missing a booking link.
 *
 * Ordered so a backfill run is reproducible and its log reads in a
 * stable order.
 */
export const listActiveConsultantsWithoutSlug =
  async (): Promise<
    RepositoryResult<
      Array<{ id: string; displayName: string | null }>
    >
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .select("id, display_name")
        .is("consultant_slug", null)
        .eq("is_active", true)
        .order("id", { ascending: true });

    if (error) {
      console.error(
        "Consultant slug backfill listing failed",
        {
          code: error.code,
          message: error.message,
        },
      );

      return { ok: false };
    }

    return {
      ok: true,
      data: (
        (data ?? []) as Array<{
          id: string;
          display_name: string | null;
        }>
      ).map((row) => ({
        id: row.id,
        displayName: row.display_name,
      })),
    };
  };
