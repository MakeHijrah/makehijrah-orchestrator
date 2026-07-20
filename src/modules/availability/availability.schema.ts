import { z } from "zod";

export const availabilityQuerySchema = z
  .object({
    consultant_id: z.string().uuid(),

    from: z
      .string()
      .datetime({
        offset: true,
      }),

    to: z
      .string()
      .datetime({
        offset: true,
      }),
  })
  .superRefine((value, context) => {
    const from = new Date(value.from);
    const to = new Date(value.to);

    if (to <= from) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "`to` must be later than `from`.",
      });

      return;
    }

    const maximumWindowMilliseconds =
      14 * 24 * 60 * 60 * 1000;

    if (
      to.getTime() - from.getTime() >
      maximumWindowMilliseconds
    ) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "Availability may be requested for a maximum of 14 days.",
      });
    }
  });

export type AvailabilityQuery = z.infer<
  typeof availabilityQuerySchema
>;
