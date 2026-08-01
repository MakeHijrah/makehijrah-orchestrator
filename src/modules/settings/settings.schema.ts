import { IANAZone } from "luxon";
import { z } from "zod";

/*
 * Admin settings request schemas. PROJECT_LOCK Amendment 007
 * sections 4 and 5.
 *
 * Both bodies are .strict(): an unknown key is a rejection, not a
 * silently ignored field. That is what keeps this from drifting
 * into a generic settings writer, which section 6.5 of the
 * amendment prohibits.
 *
 * Bounds mirror the database check constraints from migration 025
 * exactly, so a value that passes here cannot fail at the database.
 */

export const PRICE_CENTS_MINIMUM = 100;
export const PRICE_CENTS_MAXIMUM = 1_000_000;
export const DURATION_MINUTES_MINIMUM = 15;
export const DURATION_MINUTES_MAXIMUM = 240;

const supportEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);

export const updateSettingsSchema = z
  .object({
    consultation_price_cents: z
      .number()
      .int()
      .min(PRICE_CENTS_MINIMUM)
      .max(PRICE_CENTS_MAXIMUM)
      .optional(),

    consultation_duration_minutes: z
      .number()
      .int()
      .min(DURATION_MINUTES_MINIMUM)
      .max(DURATION_MINUTES_MAXIMUM)
      .optional(),

    /*
     * Explicitly nullable: clearing the support email is a
     * legitimate action, distinct from omitting the field.
     */
    support_email: supportEmailSchema
      .nullable()
      .optional(),

    default_timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(
        (value) =>
          IANAZone.isValidZone(value),
        {
          message:
            "A valid IANA timezone is required.",
        },
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).length > 0,
    {
      message:
        "At least one setting must be supplied.",
    },
  );

export const updateStripeModeSchema = z
  .object({
    stripe_mode: z.enum([
      "test",
      "live",
    ]),

    /*
     * Required only when switching to live. Amendment 007
     * section 5.5.
     */
    confirm_live: z
      .boolean()
      .optional(),
  })
  .strict();

export type UpdateSettingsInput =
  z.infer<typeof updateSettingsSchema>;

export type UpdateStripeModeInput =
  z.infer<
    typeof updateStripeModeSchema
  >;
