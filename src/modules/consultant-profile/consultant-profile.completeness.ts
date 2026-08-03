import { IANAZone } from "luxon";
import { hasUsableWorkingHours } from "./consultant-profile.working-hours.js";

/*
 * Shared consultant profile completeness evaluator.
 * PROJECT_LOCK Amendment 008.
 *
 * One evaluator, three callers:
 *   - consultant submit
 *   - active consultant update
 *   - admin consultant activation
 *
 * Having a single implementation is the point. Three near-identical
 * rule sets would drift, and the failure mode of that drift is a
 * consultant who can submit a profile the admin can never activate.
 *
 * Pure: no database access, no clock, no network. Every input is
 * the already-merged final state.
 */

/*
 * Stable machine-readable identifiers. These are part of the API
 * contract and are returned in error.details.missing. Do not
 * rename them.
 */
export type ProfileRequirement =
  | "avatar"
  | "full_name"
  | "gender"
  | "headline"
  | "bio"
  | "timezone"
  | "minimum_booking_notice_hours"
  | "booking_capability"
  | "country_ids"
  | "working_hours"
  | "google_calendar"
  | "gender_immutable";

export type GoogleConnectionState = {
  revokedAt: string | null;
  encryptedRefreshToken: string | null;
};

/*
 * The merged final state: stored values with the request's
 * non-null fields already applied. Evaluating the request alone
 * would wrongly reject a consultant who supplies nothing because
 * everything is already stored.
 */
export type MergedProfileState = {
  avatarUrl: string | null;
  fullName: string | null;
  gender: string | null;
  headline: string | null;
  bio: string | null;
  timezone: string | null;
  minimumBookingNoticeHours: number | null;
  availableForGeneral: boolean;
  /* Active country assignments after the save. */
  countryIds: string[];
  workingHours: unknown;
  googleConnection: GoogleConnectionState | null;
};

export const MINIMUM_BOOKING_NOTICE_MIN = 0;
export const MINIMUM_BOOKING_NOTICE_MAX = 336;

const isBlank = (
  value: string | null,
): boolean =>
  value === null ||
  value.trim() === "";

export const isActiveGoogleConnection = (
  connection:
    | GoogleConnectionState
    | null,
): boolean =>
  Boolean(
    connection &&
      connection.revokedAt === null &&
      connection.encryptedRefreshToken &&
      connection.encryptedRefreshToken.trim() !==
        "",
  );

export const isValidTimezone = (
  value: string | null,
): boolean =>
  Boolean(
    value &&
      value.trim() !== "" &&
      IANAZone.isValidZone(
        value.trim(),
      ),
  );

export const isValidMinimumNotice = (
  value: number | null,
): boolean =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MINIMUM_BOOKING_NOTICE_MIN &&
  value <= MINIMUM_BOOKING_NOTICE_MAX;

/*
 * Returns EVERY unmet requirement, never just the first, so a
 * consultant fixes their profile in one pass rather than
 * discovering problems one submission at a time.
 *
 * Identifiers are emitted in a stable order.
 */
export const evaluateProfileCompleteness =
  (
    state: MergedProfileState,
  ): ProfileRequirement[] => {
    const missing: ProfileRequirement[] =
      [];

    if (isBlank(state.avatarUrl)) {
      missing.push("avatar");
    }

    if (isBlank(state.fullName)) {
      missing.push("full_name");
    }

    if (
      state.gender !== "male" &&
      state.gender !== "female"
    ) {
      missing.push("gender");
    }

    if (isBlank(state.headline)) {
      missing.push("headline");
    }

    if (isBlank(state.bio)) {
      missing.push("bio");
    }

    if (
      !isValidTimezone(state.timezone)
    ) {
      missing.push("timezone");
    }

    if (
      !isValidMinimumNotice(
        state.minimumBookingNoticeHours,
      )
    ) {
      missing.push(
        "minimum_booking_notice_hours",
      );
    }

    /*
     * Booking capability is the real business rule: a consultant
     * must be reachable somehow. Either they serve at least one
     * country, or they accept general consultations. Neither is
     * individually required; having neither is.
     */
    const hasCountry =
      state.countryIds.length > 0;

    if (
      !hasCountry &&
      !state.availableForGeneral
    ) {
      missing.push(
        "booking_capability",
      );
    }

    if (
      !hasUsableWorkingHours(
        state.workingHours,
      )
    ) {
      missing.push("working_hours");
    }

    if (
      !isActiveGoogleConnection(
        state.googleConnection,
      )
    ) {
      missing.push(
        "google_calendar",
      );
    }

    return missing;
  };
