import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.js";
import { publishDueBlogPosts } from "./blog-publishing.service.js";

/*
 * The scheduled-blog-publishing worker. publish_due_blog_posts()
 * (migration 052) has existed since the blog schema was imported
 * into this repository, and until now nothing ever called it — a
 * post scheduled for a future date stayed 'scheduled' forever,
 * because no recurring job existed anywhere to invoke the
 * function that flips it.
 *
 * Modelled on draft-expiry.worker.ts, which is the closest
 * precedent in this codebase: a single set-based UPDATE inside an
 * RPC, invoked on a timer, safe for multiple orchestrator
 * instances by construction rather than by coordination.
 * publish_due_blog_posts() is one plain UPDATE statement — no
 * per-row loop, no application-side batching — so ordinary
 * PostgreSQL row locking is what makes two replicas running the
 * same cycle safe: the second UPDATE simply finds nothing left
 * matching `status = 'scheduled'` once the first has run, rather
 * than racing it or double-publishing anything.
 *
 * The Redis cycle lock below is therefore an optimisation, not a
 * correctness requirement: it stops every replica performing the
 * same no-op scan every five minutes. It fails open — if Redis is
 * unreachable the cycle simply runs unguarded, and the result is
 * identical, because the RPC's own atomicity is what actually
 * prevents a double-publish.
 *
 * No new public endpoint. The worker is the only caller.
 */

/*
 * No urgency comparable to a payment authorization deadline or a
 * booking notification: a scheduled post publishing a few minutes
 * late is a non-event. Five minutes, per the project's own
 * guidance for this job -- longer than every latency-sensitive
 * notification worker (10s) and the slot-reclaiming draft-expiry
 * worker (60s), because this job has no deadline either of those
 * has.
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const CYCLE_LOCK_KEY = "blog-publishing:cycle";

/*
 * Shorter than the interval, so a replica that dies mid-cycle
 * cannot suppress the next one for long.
 */
const CYCLE_LOCK_TTL_SECONDS = 4 * 60;

let workerInterval: NodeJS.Timeout | null = null;

let cycleRunning = false;

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end

  return 0
`;

/*
 * Returns a token when this replica took the cycle, null when
 * another replica holds it -- and a token when Redis itself
 * failed, because failing open is correct here. A duplicated
 * cycle costs one extra no-op RPC call; a suppressed cycle costs
 * a scheduled post staying unpublished for another interval.
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
      "Blog publishing cycle lock failed; running the cycle anyway",
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
      "Blog publishing cycle lock release failed",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const runWorkerCycle = async (): Promise<void> => {
  /* Re-entrancy within this process. */
  if (cycleRunning) {
    return;
  }

  cycleRunning = true;

  const lockToken = await acquireCycleLock();

  if (!lockToken) {
    cycleRunning = false;

    return;
  }

  try {
    const result = await publishDueBlogPosts();

    if (!result.ok) {
      /*
       * Logged by the service, with the RPC's own error detail.
       * Nothing is retried here: the next tick is five minutes
       * away and any still-due post will still be due then.
       */
      return;
    }

    if (result.publishedCount > 0) {
      console.info(
        "Scheduled blog posts published",
        { publishedCount: result.publishedCount },
      );
    }
  } catch (error) {
    console.error(
      "Blog publishing worker cycle failed",
      {
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

export const startBlogPublishingWorker =
  (): void => {
    if (workerInterval) {
      return;
    }

    /*
     * One cycle at startup, so a deploy immediately publishes
     * anything that came due while the process was down.
     */
    void runWorkerCycle();

    workerInterval = setInterval(() => {
      void runWorkerCycle();
    }, POLL_INTERVAL_MS);
  };

export const stopBlogPublishingWorker =
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
export const runBlogPublishingCycleForTest =
  runWorkerCycle;
