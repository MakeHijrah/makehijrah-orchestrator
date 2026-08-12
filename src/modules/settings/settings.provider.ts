import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Application settings provider. PROJECT_LOCK Amendment 007.
 *
 * public.app_settings is a singleton table reachable only by the
 * service role: RLS is enabled with zero policies and anon and
 * authenticated are revoked. Every read and write goes through
 * here.
 *
 * Fails closed. If the row cannot be read, or if the singleton
 * invariant is violated, callers get an error rather than a
 * plausible-looking default. A booking created at the wrong price
 * is worse than a booking that fails.
 */

export type StripeModeSetting =
  | "test"
  | "live";

export type AppSettings = {
  id: string;
  consultation_price_cents: number;
  /*
   * The consultant's share of a standard consultation, in basis
   * points. Read by record_consultation_earning and by the base
   * component of record_direct_booking_earning - this projection
   * exists so the orchestrator can PUBLISH the same figure to the
   * direct booking calculator without keeping a second copy of it.
   * Amendment 014.
   */
  consultation_consultant_commission_bps: number;
  consultation_currency: string;
  consultation_duration_minutes: number;
  stripe_mode: StripeModeSetting;
  support_email: string | null;
  default_timezone: string;
  updated_at: string;
};

const SETTINGS_COLUMNS = [
  "id",
  "consultation_price_cents",
  "consultation_consultant_commission_bps",
  "consultation_currency",
  "consultation_duration_minutes",
  "stripe_mode",
  "support_email",
  "default_timezone",
  "updated_at",
].join(", ");

const CACHE_TTL_MILLISECONDS = 30_000;

type CacheEntry = {
  settings: AppSettings;
  expiresAt: number;
};

let cache: CacheEntry | null = null;

export class SettingsUnavailableError extends Error {
  constructor(message: string) {
    super(message);

    this.name =
      "SettingsUnavailableError";
  }
}

export const invalidateSettingsCache =
  (): void => {
    cache = null;
  };

/*
 * Read the singleton row, bypassing the cache.
 *
 * Deliberately selects up to two rows rather than using
 * maybeSingle(), so a violated singleton invariant is detected and
 * reported instead of silently picking the first row.
 */
const loadSettings =
  async (): Promise<AppSettings> => {
    const { data, error } =
      await supabaseAdmin
        .from("app_settings")
        .select(SETTINGS_COLUMNS)
        .limit(2);

    if (error) {
      console.error(
        "App settings lookup failed",
        {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      throw new SettingsUnavailableError(
        "The application settings could not be loaded.",
      );
    }

    const rows =
      (data ?? []) as unknown as AppSettings[];

    if (rows.length === 0) {
      console.error(
        "App settings row is missing",
        {
          rowCount: 0,
        },
      );

      throw new SettingsUnavailableError(
        "The application settings row is missing.",
      );
    }

    if (rows.length > 1) {
      console.error(
        "App settings singleton invariant violated",
        {
          rowCount: rows.length,
        },
      );

      throw new SettingsUnavailableError(
        "The application settings are not a singleton.",
      );
    }

    return rows[0]!;
  };

export const getSettings =
  async (): Promise<AppSettings> => {
    const now = Date.now();

    if (
      cache &&
      cache.expiresAt > now
    ) {
      return cache.settings;
    }

    const settings =
      await loadSettings();

    cache = {
      settings,
      expiresAt:
        now + CACHE_TTL_MILLISECONDS,
    };

    return settings;
  };

export type UpdateSettingsPatch = {
  consultation_price_cents?: number;
  consultation_duration_minutes?: number;
  support_email?: string | null;
  default_timezone?: string;
  stripe_mode?: StripeModeSetting;
};

/*
 * Apply a patch to the singleton row and invalidate the cache.
 *
 * updated_at is left to the set_app_settings_updated_at trigger.
 * The cache is cleared before the fresh row is returned, so a
 * caller can never observe a stale value after a successful write.
 */
export const updateSettings = async ({
  patch,
  adminProfileId,
}: {
  patch: UpdateSettingsPatch;
  adminProfileId: string;
}): Promise<AppSettings> => {
  const current = await loadSettings();

  const { data, error } =
    await supabaseAdmin
      .from("app_settings")
      .update({
        ...patch,
        updated_by_admin_profile_id:
          adminProfileId,
      })
      .eq("id", current.id)
      .select(SETTINGS_COLUMNS)
      .maybeSingle();

  invalidateSettingsCache();

  if (error) {
    console.error(
      "App settings update failed",
      {
        adminProfileId,
        fields:
          Object.keys(patch),
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    throw new SettingsUnavailableError(
      "The application settings could not be updated.",
    );
  }

  if (!data) {
    console.error(
      "App settings update returned no row",
      {
        adminProfileId,
        fields:
          Object.keys(patch),
      },
    );

    throw new SettingsUnavailableError(
      "The application settings could not be updated.",
    );
  }

  return data as unknown as AppSettings;
};
