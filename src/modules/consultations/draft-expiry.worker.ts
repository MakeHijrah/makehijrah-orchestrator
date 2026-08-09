import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.js";
import { expireStaleDraftConsultations } from "./draft-expiry.service.js";

/*
 * The expire-drafts worker. API_CONTRACT section 5 specified it,
 * migration 001 created idx_consultations_stale_drafts for it, and
 * it was never written — so an abandoned draft reserved its slot
 * forever rather than for thirty minutes.
 *
 * Deliberately simpler than authorization-timeout.worker.ts. That
 * one processes consultations individually — each needs its own
 * Stripe call and its own emails — so it keeps a Redis due-set and
 * takes a per-consultation lock. Expiry is one set-based UPDATE
 * over the whole batch, and the database is the correctness
 * boundary:
 *
 *   FOR UPDATE SKIP LOCKED inside the RPC means two replicas
 *   running the same cycle DIVIDE the backlog rather than
 *   duplicating or blocking on it, and a row cancelled by one is
 *   no longer 'draft' for the other.
 *
 * So the Redis cycle lock below is purely an optimisation: it stops
 * three replicas doing the same empty scan every minute. It may
 * fail open — if Redis is unreachable the cycle simply runs, and
 * the result is identical.
 */

const POLL_INTERVAL_MS = 60 * 1000;

const BATCH_SIZE = 200;

/*
 * A bound on one cycle, so a very large backlog is drained over
 * several minutes instead of one cycle running unboundedly while
 * the interval fires again behind it.
 */
const MAX_BATCHES_PER_CYCLE = 10;

const CYCLE_LOCK_KEY =
  "draft-expiry:cycle";

/*
 * Shorter than the interval, so a replica that dies mid-cycle
 * cannot suppress the next one for long.
 */
const CYCLE_LOCK_TTL_SECONDS = 50;

let workerInterval:
  | NodeJS.Timeout
  | null = null;

let cycleRunning = false;

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end

  return 0
`;

/*
 * Returns a token when this replica took the cycle, null when
 * another replica holds it — and a token when Redis itself failed,
 * because failing open is correct here. A duplicated cycle costs
 * one extra empty scan; a suppressed cycle costs a slot staying
 * reserved.
 */
const acquireCycleLock = async (): Promise<
  string | null
> => {
  const token = randomUUID();

  try {
    const result = await redis.set(
      CYCLE_LOCK_KEY,
      token,
      "EX",
      CYCLE_LOCK_TTL_SECONDS,
      "NX",
    );

    return result === "OK" ? token : null;
  } catch (error) {
    console.error(
      "Draft expiry cycle lock failed; running the cycle anyway",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );

    return token;
  }
};

const releaseCycleLock = async (
  token: string,
): Promise<void> => {
  try {
    await redis.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      CYCLE_LOCK_KEY,
      token,
    );
  } catch (error) {
    console.error(
      "Draft expiry cycle lock release failed",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const runWorkerCycle =
  async (): Promise<void> => {
    /* Re-entrancy within this process. */
    if (cycleRunning) {
      return;
    }

    cycleRunning = true;

    const lockToken =
      await acquireCycleLock();

    if (!lockToken) {
      cycleRunning = false;

      return;
    }

    let totalExpired = 0;

    try {
      for (
        let batch = 0;
        batch < MAX_BATCHES_PER_CYCLE;
        batch += 1
      ) {
        const result =
          await expireStaleDraftConsultations(
            BATCH_SIZE,
          );

        if (!result.ok) {
          /*
           * Logged by the service. Nothing is retried here: the
           * next tick is sixty seconds away and the same rows will
           * still be stale.
           */
          break;
        }

        totalExpired +=
          result.expired.length;

        /*
         * Every released slot is logged individually. These are
         * bookings somebody started and did not finish, and a
         * consultant asking "why did that slot reopen" deserves an
         * answer.
         */
        for (const draft of result.expired) {
          console.info(
            "Draft consultation expired and its slot released",
            {
              consultationId:
                draft.consultationId,
              consultantId:
                draft.consultantId,
              scheduledStartAt:
                draft.scheduledStartAt,
            },
          );
        }

        if (!result.batchFull) {
          break;
        }
      }

      if (totalExpired > 0) {
        console.info(
          "Draft expiry cycle complete",
          { expired: totalExpired },
        );
      }
    } catch (error) {
      console.error(
        "Draft expiry worker cycle failed",
        {
          expired: totalExpired,
          message:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
      );
    } finally {
      await releaseCycleLock(lockToken);

      cycleRunning = false;
    }
  };

export const startDraftExpiryWorker =
  (): void => {
    if (workerInterval) {
      return;
    }

    /*
     * One cycle at startup, so a deploy immediately clears
     * whatever accumulated while the process was down.
     */
    void runWorkerCycle();

    workerInterval = setInterval(() => {
      void runWorkerCycle();
    }, POLL_INTERVAL_MS);
  };

export const stopDraftExpiryWorker =
  async (): Promise<void> => {
    if (workerInterval) {
      clearInterval(workerInterval);

      workerInterval = null;
    }

    /* Let an in-flight cycle finish rather than tearing it up. */
    while (cycleRunning) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  };

/* Exported for tests, which drive cycles directly. */
export const runDraftExpiryCycleForTest =
  runWorkerCycle;
