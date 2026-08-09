/*
 * One-off backfill: give every active consultant a booking link.
 *
 *   npm run backfill:consultant-slugs
 *
 * PROJECT_LOCK Amendment 012 makes consultant slugs admin-managed
 * and generates one at activation. Consultants activated BEFORE
 * that have no link, so their booking page has no address — this
 * closes that gap once.
 *
 * WHY THIS IS A SCRIPT AND NOT SQL:
 *
 * Deriving a slug means normalizing a name (trim, lowercase, NFKD,
 * drop combining marks, hyphenate, collapse), checking it against
 * the reserved set, and suffixing on collision. The reserved set is
 * a fact about the frontend's routing table and deliberately lives
 * in the orchestrator; the normalizer is the one every other slug
 * goes through. Reimplementing either in a migration would create a
 * second set of rules that could disagree with the first, and the
 * day they disagreed a backfilled consultant would hold /dashboard.
 *
 * So this calls exactly the same generator activation calls.
 *
 * SAFETY, in the order it matters:
 * - It only ever selects consultants whose slug IS NULL, and the
 *   claim itself is guarded by `is('consultant_slug', null)`. An
 *   existing link cannot be overwritten by this script even if it
 *   were called wrongly.
 * - It is idempotent. A second run finds nothing and changes
 *   nothing.
 * - It does NOT enable direct booking. A link is an address, not a
 *   decision to publish; that stays the consultant's.
 * - One consultant failing does not stop the rest, and every
 *   failure is named at the end.
 */

import { backfillConsultantSlugs } from "../modules/direct-booking/direct-booking.assignment.service.js";

const main = async (): Promise<void> => {
  console.log(
    "Backfilling booking links for active consultants without one...",
  );

  const result =
    await backfillConsultantSlugs();

  if (!result.ok) {
    console.error(
      `Backfill could not start: ${result.message}`,
    );

    process.exitCode = 1;

    return;
  }

  const assigned = result.outcomes.filter(
    (outcome) => outcome.status === "assigned",
  );

  const skipped = result.outcomes.filter(
    (outcome) => outcome.status === "skipped",
  );

  const failed = result.outcomes.filter(
    (outcome) => outcome.status === "failed",
  );

  /*
   * Every assignment is logged individually with the consultant id
   * beside the link. This is a one-off write against live rows and
   * somebody should be able to read exactly what it did — and undo
   * one entry by hand if a generated link turns out to be wrong.
   */
  for (const outcome of assigned) {
    console.log(
      `  assigned  ${outcome.consultantId}  ->  ${outcome.slug}`,
    );
  }

  for (const outcome of skipped) {
    console.log(
      `  skipped   ${outcome.consultantId}  (${outcome.reason})`,
    );
  }

  for (const outcome of failed) {
    console.error(
      `  FAILED    ${outcome.consultantId}  (${outcome.reason})`,
    );
  }

  console.log(
    `\nDone. ${assigned.length} assigned, ${skipped.length} skipped, ${failed.length} failed.`,
  );

  if (assigned.length === 0 && failed.length === 0) {
    console.log(
      "Nothing to do — every active consultant already has a booking link.",
    );
  }

  if (failed.length > 0) {
    /*
     * A non-zero exit so a deployment step that runs this notices.
     * The usual cause is a consultant with no usable name, which
     * needs a human to give them one rather than a retry.
     */
    console.error(
      "\nSome consultants could not be given a booking link. NO_USABLE_NAME means the consultant has no display name and no profile name; give them one and rerun.",
    );

    process.exitCode = 1;
  }
};

await main();
