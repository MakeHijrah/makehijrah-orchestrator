/*
 * The draft hold, in one place.
 *
 * A draft consultation IS the slot hold: unique_reserved_consultant_
 * slot covers 'draft', so while the row sits there nobody else can
 * book that time. The hold lasts thirty minutes from creation.
 *
 * THE AUTHORITATIVE DEFINITION IS IN SQL, not here.
 * create_draft_consultation returns hold_expires_at as
 * created_at + interval '30 minutes', and
 * expire_stale_draft_consultations cancels drafts past the same
 * cutoff. Both live in the database, beside each other, because a
 * worker that disagreed with hold_expires_at would either cancel
 * live bookings or leave dead ones standing.
 *
 * This module exists so the TypeScript side has ONE copy of that
 * number rather than one per consumer. It was previously private to
 * checkout.service.ts and about to be copied a second time. If the
 * hold ever changes, it changes in the migrations first and here
 * second, and nowhere else.
 */

export const DRAFT_HOLD_MINUTES = 30;

const DRAFT_HOLD_MILLISECONDS =
  DRAFT_HOLD_MINUTES * 60 * 1000;

/*
 * When a draft created at `createdAt` stops holding its slot.
 *
 * Null for an unparseable timestamp rather than a guessed one — a
 * caller must treat that as a failure, not as a hold of unknown
 * length. That distinction is what migration 046's regression
 * turned on: a missing timestamp became NaN and then a 500, which
 * was correct behaviour reached by an incorrect route.
 */
export const calculateHoldExpiration = (
  createdAt: string,
): string | null => {
  const createdAtMilliseconds =
    Date.parse(createdAt);

  if (
    !Number.isFinite(createdAtMilliseconds)
  ) {
    return null;
  }

  return new Date(
    createdAtMilliseconds +
      DRAFT_HOLD_MILLISECONDS,
  ).toISOString();
};

export const isHoldExpired = (
  createdAt: string,
  now: number = Date.now(),
): boolean => {
  const expiresAt =
    calculateHoldExpiration(createdAt);

  if (!expiresAt) {
    /* Unknown means unusable. Fail closed. */
    return true;
  }

  return Date.parse(expiresAt) <= now;
};
