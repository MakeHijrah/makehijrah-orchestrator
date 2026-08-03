import { supabaseAdmin } from "../../lib/supabase.js";
import type { GoogleConnectionState } from "./consultant-profile.completeness.js";

/*
 * Data access for consultant profile saves.
 * PROJECT_LOCK Amendment 008.
 *
 * Every read here uses the service-role client. The consultant
 * identifier is always resolved server-side from the authenticated
 * profile; it is never taken from a request body.
 */

export type ConsultantProfileRow = {
  id: string;
  profile_id: string;
  gender: string | null;
  headline: string | null;
  bio: string | null;
  timezone: string | null;
  minimum_booking_notice_hours: number;
  available_for_general: boolean;
  working_hours_jsonb: unknown;
  is_active: boolean;
  onboarding_completed_at: string | null;
  full_name: string | null;
  avatar_url: string | null;
};

const CONSULTANT_COLUMNS = [
  "id",
  "profile_id",
  "gender",
  "headline",
  "bio",
  "timezone",
  "minimum_booking_notice_hours",
  "available_for_general",
  "working_hours_jsonb",
  "is_active",
  "onboarding_completed_at",
].join(", ");

type ConsultantRow = Omit<
  ConsultantProfileRow,
  "full_name" | "avatar_url"
>;

export type RepositoryResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
    };

/*
 * Resolve the consultant from the authenticated profile.
 *
 * consultants.profile_id is unique, so this is the whole of the
 * ownership model: an authenticated consultant can only ever
 * address their own row, and there is no code path that accepts a
 * consultant identifier from outside.
 */
export const loadConsultantByProfileId =
  async (
    profileId: string,
  ): Promise<
    RepositoryResult<ConsultantProfileRow | null>
  > => {
    const {
      data: consultantData,
      error: consultantError,
    } = await supabaseAdmin
      .from("consultants")
      .select(CONSULTANT_COLUMNS)
      .eq("profile_id", profileId)
      .maybeSingle();

    if (consultantError) {
      console.error(
        "Consultant profile lookup failed",
        {
          profileId,
          code: consultantError.code,
          message:
            consultantError.message,
        },
      );

      return { ok: false };
    }

    if (!consultantData) {
      return {
        ok: true,
        data: null,
      };
    }

    const consultant =
      consultantData as unknown as ConsultantRow;

    const {
      data: profileData,
      error: profileError,
    } = await supabaseAdmin
      .from("profiles")
      .select("full_name, avatar_url")
      .eq("id", profileId)
      .maybeSingle();

    if (profileError) {
      console.error(
        "Consultant profile owner lookup failed",
        {
          profileId,
          code: profileError.code,
          message: profileError.message,
        },
      );

      return { ok: false };
    }

    const owner =
      (profileData ?? {}) as {
        full_name?: string | null;
        avatar_url?: string | null;
      };

    return {
      ok: true,
      data: {
        ...consultant,
        full_name:
          owner.full_name ?? null,
        avatar_url:
          owner.avatar_url ?? null,
      },
    };
  };

export const loadConsultantById =
  async (
    consultantId: string,
  ): Promise<
    RepositoryResult<ConsultantProfileRow | null>
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .select(CONSULTANT_COLUMNS)
        .eq("id", consultantId)
        .maybeSingle();

    if (error) {
      console.error(
        "Consultant lookup by id failed",
        {
          consultantId,
          code: error.code,
          message: error.message,
        },
      );

      return { ok: false };
    }

    if (!data) {
      return {
        ok: true,
        data: null,
      };
    }

    const consultant =
      data as unknown as ConsultantRow;

    return loadConsultantByProfileId(
      consultant.profile_id,
    );
  };

export const loadCountryIds = async (
  consultantId: string,
): Promise<
  RepositoryResult<string[]>
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultant_countries")
      .select("country_id")
      .eq(
        "consultant_id",
        consultantId,
      );

  if (error) {
    console.error(
      "Consultant country lookup failed",
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
    data: (
      (data ?? []) as Array<{
        country_id: string;
      }>
    ).map((row) => row.country_id),
  };
};

/*
 * Validate supplied country identifiers against the catalog.
 *
 * The RPC re-checks this and is the real referee, but doing it
 * here first turns an opaque database marker into a precise
 * message naming how many identifiers were rejected, without
 * leaking any database text.
 */
export const loadActiveCountryIds =
  async (
    countryIds: string[],
  ): Promise<
    RepositoryResult<string[]>
  > => {
    if (countryIds.length === 0) {
      return {
        ok: true,
        data: [],
      };
    }

    const { data, error } =
      await supabaseAdmin
        .from("countries")
        .select("id")
        .in("id", countryIds)
        .eq("is_active", true);

    if (error) {
      console.error(
        "Country validation lookup failed",
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
        }>
      ).map((row) => row.id),
    };
  };

export const loadGoogleConnection =
  async (
    consultantId: string,
  ): Promise<
    RepositoryResult<GoogleConnectionState | null>
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("oauth_connections")
        .select(
          "revoked_at, encrypted_refresh_token",
        )
        .eq(
          "consultant_id",
          consultantId,
        )
        .eq("provider", "google")
        .maybeSingle();

    if (error) {
      console.error(
        "Consultant Google connection lookup failed",
        {
          consultantId,
          code: error.code,
          message: error.message,
        },
      );

      return { ok: false };
    }

    const row = data as {
      revoked_at: string | null;
      encrypted_refresh_token:
        | string
        | null;
    } | null;

    return {
      ok: true,
      data: row
        ? {
            revokedAt:
              row.revoked_at,
            encryptedRefreshToken:
              row.encrypted_refresh_token,
          }
        : null,
    };
  };

/*
 * Markers raised by save_consultant_profile (migration 027).
 * The raw PostgreSQL message is never returned to a caller.
 */
export type RpcMarker =
  | "CONSULTANT_PROFILE_MODE_INVALID"
  | "CONSULTANT_PROFILE_NOT_FOUND"
  | "CONSULTANT_ONBOARDING_ALREADY_COMPLETED"
  | "CONSULTANT_ONBOARDING_INCOMPLETE"
  | "CONSULTANT_GENDER_INVALID"
  | "CONSULTANT_GENDER_IMMUTABLE"
  | "CONSULTANT_COUNTRY_INVALID";

const RPC_MARKERS: RpcMarker[] = [
  "CONSULTANT_PROFILE_MODE_INVALID",
  "CONSULTANT_PROFILE_NOT_FOUND",
  "CONSULTANT_ONBOARDING_ALREADY_COMPLETED",
  "CONSULTANT_ONBOARDING_INCOMPLETE",
  "CONSULTANT_GENDER_INVALID",
  "CONSULTANT_GENDER_IMMUTABLE",
  "CONSULTANT_COUNTRY_INVALID",
];

export const readRpcMarker = (
  message: string | null | undefined,
): RpcMarker | null => {
  if (!message) {
    return null;
  }

  return (
    RPC_MARKERS.find((marker) =>
      message.includes(marker),
    ) ?? null
  );
};

export type SaveRpcResult =
  | {
      ok: true;
      consultantId: string;
      onboardingCompletedAt:
        | string
        | null;
    }
  | {
      ok: false;
      marker: RpcMarker | null;
    };

export type SaveRpcInput = {
  consultantId: string;
  mode: "draft" | "submit" | "update";
  fullName: string | null;
  avatarUrl: string | null;
  gender: string | null;
  headline: string | null;
  bio: string | null;
  timezone: string | null;
  minimumBookingNoticeHours:
    | number
    | null;
  availableForGeneral: boolean | null;
  countryIds: string[] | null;
  workingHours: unknown;
};

/*
 * The single transactional write path. Every failure rolls back
 * inside the database; nothing partial can survive.
 */
export const saveConsultantProfile =
  async (
    input: SaveRpcInput,
  ): Promise<SaveRpcResult> => {
    const { data, error } =
      await supabaseAdmin.rpc(
        "save_consultant_profile",
        {
          p_consultant_id:
            input.consultantId,
          p_mode: input.mode,
          p_full_name: input.fullName,
          p_avatar_url:
            input.avatarUrl,
          p_gender: input.gender,
          p_headline: input.headline,
          p_bio: input.bio,
          p_timezone: input.timezone,
          p_minimum_booking_notice_hours:
            input.minimumBookingNoticeHours,
          p_available_for_general:
            input.availableForGeneral,
          p_country_ids:
            input.countryIds,
          p_working_hours:
            input.workingHours,
        },
      );

    if (error) {
      const marker = readRpcMarker(
        error.message,
      );

      console.error(
        "Consultant profile save RPC failed",
        {
          consultantId:
            input.consultantId,
          mode: input.mode,
          marker,
          code: error.code,
          message: error.message,
        },
      );

      return {
        ok: false,
        marker,
      };
    }

    const rows = data as Array<{
      consultant_id: string;
      onboarding_completed_at:
        | string
        | null;
    }> | null;

    const row = rows?.[0];

    if (!row) {
      console.error(
        "Consultant profile save RPC returned no row",
        {
          consultantId:
            input.consultantId,
          mode: input.mode,
        },
      );

      return {
        ok: false,
        marker: null,
      };
    }

    return {
      ok: true,
      consultantId:
        row.consultant_id,
      onboardingCompletedAt:
        row.onboarding_completed_at,
    };
  };
