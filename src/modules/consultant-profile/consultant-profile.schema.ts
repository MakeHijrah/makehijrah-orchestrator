import { z } from "zod";

/*
 * Request schema for PUT /api/consultant/profile.
 * PROJECT_LOCK Amendment 008.
 *
 * .strict(): an unknown key is a rejection, matching the
 * convention set by the admin settings endpoints. It is also what
 * stops a client from smuggling consultant_id, is_active,
 * profile_id or onboarding_completed_at into the body - none of
 * those are accepted here under any name.
 *
 * Every profile field is nullable, and null means "preserve the
 * stored value". That is the RPC's contract and the schema mirrors
 * it exactly rather than inventing a second convention.
 */

export const CONSULTANT_PROFILE_MODES = [
  "draft",
  "submit",
  "update",
] as const;

export const MINIMUM_NOTICE_MIN = 0;
export const MINIMUM_NOTICE_MAX = 336;

export const consultantProfileSchema = z
  .object({
    mode: z.enum(
      CONSULTANT_PROFILE_MODES,
    ),

    full_name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .optional(),

    avatar_url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .nullable()
      .optional(),

    gender: z
      .enum(["male", "female"])
      .nullable()
      .optional(),

    headline: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .optional(),

    bio: z
      .string()
      .trim()
      .min(1)
      .max(5000)
      .nullable()
      .optional(),

    /*
     * Shape only here. IANA validity is checked by the shared
     * completeness evaluator, so submit, active update and admin
     * activation all apply the identical rule.
     */
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .optional(),

    minimum_booking_notice_hours: z
      .number()
      .int()
      .min(MINIMUM_NOTICE_MIN)
      .max(MINIMUM_NOTICE_MAX)
      .nullable()
      .optional(),

    available_for_general: z
      .boolean()
      .nullable()
      .optional(),

    /*
     * null preserves assignments; [] removes them all. The two are
     * distinguished by null, never by length, which is the same
     * distinction the RPC makes.
     */
    country_ids: z
      .array(z.string().uuid())
      .max(200)
      .nullable()
      .optional(),

    /*
     * Passed through as an opaque object and validated by
     * validateWorkingHours, which reports every problem rather
     * than failing on the first.
     */
    working_hours: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
  })
  .strict();

export type ConsultantProfileInput =
  z.infer<
    typeof consultantProfileSchema
  >;
