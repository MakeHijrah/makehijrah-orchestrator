import { z } from "zod";

/*
 * Request schemas for the finance endpoints.
 *
 * Note what is absent. The payout request accepts no amount and
 * no consultant id: the amount is summed from the ledger inside
 * the RPC and the consultant comes from the bearer token. There
 * is no field for a client to put a balance in.
 */

const currencySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z]{3}$/,
    "The currency must be a three-letter code.",
  );

const noteSchema = z
  .string()
  .trim()
  .max(2_000)
  .nullable()
  .optional()
  .transform((value) => value || null);

/*
 * Currency and nothing else.
 *
 * destination_note was removed with migration 039: the payout
 * destination is now read from the consultant's saved payout
 * setting inside the RPC and snapshotted onto the payout, so
 * there is no longer a field in which one could be supplied — the
 * same treatment the amount and the consultant id already had.
 *
 * Deliberately NOT .strict(). A frontend still sending the old
 * destination_note field has it ignored rather than rejected,
 * which is what lets the database and the orchestrator ship
 * before the UI does. It is ignored, not stored: nothing below
 * reads it.
 */
export const payoutRequestSchema = z.object({
  currency: currencySchema,
});

export type PayoutRequestInput = z.infer<
  typeof payoutRequestSchema
>;

/*
 * A signed amount in the minor unit. Zero is rejected: an
 * adjustment of nothing records no financial fact. The bound is
 * ten million minor units, which is far above any plausible
 * correction and far below the integer column's ceiling.
 */
export const adjustmentSchema = z.object({
  consultant_id: z.string().uuid(),
  amount_minor: z
    .number()
    .int()
    .refine(
      (value) => value !== 0,
      "An adjustment must be a non-zero amount.",
    )
    .refine(
      (value) => Math.abs(value) <= 10_000_000,
      "The adjustment amount is out of range.",
    ),
  currency: currencySchema,
  memo: z
    .string()
    .trim()
    .min(
      1,
      "A reason is required for every adjustment.",
    )
    .max(2_000),
});

export type AdjustmentInput = z.infer<
  typeof adjustmentSchema
>;

export const payoutDecisionSchema = z.object({
  note: noteSchema,
});

export const payoutPaidSchema = z.object({
  paid_amount_minor: z
    .number()
    .int()
    .positive()
    .max(10_000_000),
  external_reference: z
    .string()
    .trim()
    .min(
      1,
      "An external reference is required.",
    )
    .max(200),
  paid_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .transform((value) => value || null),
  note: noteSchema,
});

export type PayoutPaidInput = z.infer<
  typeof payoutPaidSchema
>;

export const payoutParamsSchema = z.object({
  id: z.string().uuid(),
});
