import {
  parsePhoneNumberFromString,
} from "libphonenumber-js";
import { z } from "zod";

const genderSchema = z.enum([
  "male",
  "female",
]);

const consultantGenderPreferenceSchema = z.enum([
  "male",
  "female",
  "no_preference",
]);

const phoneCountrySchema = z
  .string()
  .trim()
  .length(2)
  .transform((value) =>
    value.toUpperCase(),
  );

const structuredWhatsappSchema = z.object({
  country_code:
    phoneCountrySchema,
  local_number: z
    .string()
    .trim()
    .regex(
      /^\d+$/,
      "Enter digits only for the WhatsApp number.",
    )
    .min(4)
    .max(20),
});

const optionalWhatsappSchema = z
  .union([
    structuredWhatsappSchema,
    z.string(),
    z.null(),
    z.undefined(),
  ])
  .transform((value, context) => {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    if (typeof value === "string") {
      const normalized =
        value.trim();

      if (normalized.length === 0) {
        return null;
      }

      const parsed =
        parsePhoneNumberFromString(
          normalized,
        );

      if (
        !parsed ||
        !parsed.isValid()
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Enter a valid WhatsApp number.",
        });

        return z.NEVER;
      }

      return parsed.number;
    }

    const parsed =
      parsePhoneNumberFromString(
        value.local_number,
        value.country_code as
          Parameters<
            typeof parsePhoneNumberFromString
          >[1],
      );

    if (
      !parsed ||
      !parsed.isValid()
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Enter a valid WhatsApp number for the selected country.",
      });

      return z.NEVER;
    }

    return parsed.number;
  });

/*
 * WHAT THIS SCHEMA DOES NOT ACCEPT, and why that is the point.
 *
 * There is no price field, no currency field, no booking_source,
 * no commission, no split, no premium and no earnings figure —
 * and there never was. Zod strips unknown keys, so a request that
 * sends `price_cents` or `booking_source` does not have them
 * ignored by a later check; they cease to exist at the schema
 * boundary and cannot reach the RPC. Every one of those values is
 * settled on the server. Amendment 011.
 *
 * TWO WAYS TO NAME A CONSULTANT, and they are not equivalent:
 *
 *   consultant_id    the generic flow. The visitor picked this
 *                    consultant from a list the server produced,
 *                    and the platform's own price applies.
 *
 *   consultant_slug  a direct booking. The server resolves the
 *                    slug to a consultant, checks that the page is
 *                    actually published, and computes the price
 *                    from that consultant's settings.
 *
 * When a slug is supplied, any consultant_id in the same request
 * is IGNORED — not merged, not preferred, not compared. Trusting a
 * browser-supplied id alongside a slug would let a request quote
 * one consultant's page and book another's calendar at that
 * consultant's price.
 */
export const createDraftConsultationSchema =
  z
    .object({
      consultant_id: z
        .string()
        .uuid()
        .optional(),

      consultant_slug: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional(),

      country_id: z
        .string()
        .uuid()
        .nullable(),

      start_at: z
        .string()
        .datetime({
          offset: true,
        }),

      client_timezone: z
        .string()
        .trim()
        .min(1)
        .max(100),

      intake: z.object({
        full_name: z
          .string()
          .trim()
          .min(1)
          .max(200),

        email: z
          .string()
          .trim()
          .email()
          .max(320),

        phone_whatsapp:
          optionalWhatsappSchema,

        answers: z.object({
          consultation_summary: z
            .string()
            .trim()
            .min(1)
            .max(5000),

          client_gender:
            genderSchema,

          preferred_consultant_gender:
            consultantGenderPreferenceSchema,
        }),
      }),
    })
    .superRefine((value, context) => {
      /*
       * Exactly one naming is required. Neither is a request that
       * names no consultant at all; both is ambiguous, and the
       * ambiguity is the dangerous case — see the note above — so
       * it is refused rather than resolved by precedence.
       */
      if (
        !value.consultant_id &&
        !value.consultant_slug
      ) {
        context.addIssue({
          code: "custom",
          path: ["consultant_id"],
          message:
            "A consultant must be selected.",
        });

        return;
      }

      if (
        value.consultant_id &&
        value.consultant_slug
      ) {
        context.addIssue({
          code: "custom",
          path: ["consultant_slug"],
          message:
            "Name a consultant by link or by identifier, not both.",
        });
      }
    });

export type CreateDraftConsultationInput =
  z.infer<
    typeof createDraftConsultationSchema
  >;
