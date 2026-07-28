import { IANAZone } from "luxon";
import { z } from "zod";

const normalizedEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);

export const createConsultantInviteSchema =
  z.object({
    email: normalizedEmailSchema,
    expires_in_days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(7),
  });

export const redeemConsultantInviteSchema =
  z.object({
    token: z
      .string()
      .trim()
      .min(32)
      .max(512),
    profile: z.object({
      full_name: z
        .string()
        .trim()
        .min(1)
        .max(200),
      timezone: z
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
        ),
      gender: z.enum([
        "male",
        "female",
      ]),
    }),
  });

export type CreateConsultantInviteInput =
  z.infer<
    typeof createConsultantInviteSchema
  >;

export type RedeemConsultantInviteInput =
  z.infer<
    typeof redeemConsultantInviteSchema
  >;