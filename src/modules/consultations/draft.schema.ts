import { z } from "zod";

const optionalWhatsappSchema = z
  .union([
    z.string(),
    z.null(),
    z.undefined(),
  ])
  .transform((value) => {
    if (typeof value !== "string") {
      return null;
    }

    const normalized = value.trim();

    return normalized.length > 0
      ? normalized
      : null;
  });

export const createDraftConsultationSchema = z.object({
  consultant_id: z.string().uuid(),

  country_id: z
    .string()
    .uuid()
    .nullable(),

  start_at: z.string().datetime({
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

    phone_whatsapp: optionalWhatsappSchema,

    answers: z.object({
      consultation_summary: z
        .string()
        .trim()
        .min(1)
        .max(5000),
    }),
  }),
});

export type CreateDraftConsultationInput =
  z.infer<typeof createDraftConsultationSchema>;
