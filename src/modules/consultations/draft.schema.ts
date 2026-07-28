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

export const createDraftConsultationSchema =
  z.object({
    consultant_id: z
      .string()
      .uuid(),

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
  });

export type CreateDraftConsultationInput =
  z.infer<
    typeof createDraftConsultationSchema
  >;
