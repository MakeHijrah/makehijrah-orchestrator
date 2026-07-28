import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.js";
import {
  listOAuthHealthAlertCandidates,
  processOAuthHealthAlert,
} from "./oauth-health-alert.service.js";

const POLL_INTERVAL_MS =
  15 * 60 * 1000;

const RETRY_DELAY_MS =
  60 * 1000;

const LOCK_TTL_SECONDS =
  180;

const BATCH_SIZE = 25;

const DUE_SET =
  "oauth-health-alert:due";

const LOCK_PREFIX =
  "oauth-health:lock:";

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

type AcquiredLock = {
  key: string;
  token: string;
};

const acquireLock = async (
  consultantId: string,
): Promise<AcquiredLock | null> => {
  const key =
    `${LOCK_PREFIX}${consultantId}`;

  const token =
    randomUUID();

  try {
    const result =
      await redis.set(
        key,
        token,
        "EX",
        LOCK_TTL_SECONDS,
        "NX",
      );

    return result === "OK"
      ? {
          key,
          token,
        }
      : null;
  } catch (error) {
    console.error(
      "OAuth health alert lock acquisition failed",
      {
        consultantId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );

    return null;
  }
};

const releaseLock = async (
  consultantId: string,
  lock: AcquiredLock,
): Promise<void> => {
  try {
    await redis.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      lock.key,
      lock.token,
    );
  } catch (error) {
    console.error(
      "OAuth health alert lock release failed",
      {
        consultantId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const scheduleRetry = async (
  consultantId: string,
): Promise<void> => {
  await redis.zadd(
    DUE_SET,
    Date.now() +
      RETRY_DELAY_MS,
    consultantId,
  );
};

const removeJob = async (
  consultantId: string,
): Promise<void> => {
  await redis.zrem(
    DUE_SET,
    consultantId,
  );
};

const seedDueJobs = async (): Promise<void> => {
  const result =
    await listOAuthHealthAlertCandidates(
      BATCH_SIZE,
    );

  if (!result.ok) {
    console.error(
      "OAuth health alert candidate seeding failed",
      {
        message: result.message,
      },
    );

    return;
  }

  if (
    result.consultantIds.length ===
    0
  ) {
    return;
  }

  const pipeline =
    redis.multi();

  for (
    const consultantId of
    result.consultantIds
  ) {
    pipeline.zadd(
      DUE_SET,
      "NX",
      Date.now(),
      consultantId,
    );
  }

  await pipeline.exec();
};

const processDueAlert = async (
  consultantId: string,
): Promise<void> => {
  const lock =
    await acquireLock(
      consultantId,
    );

  if (!lock) {
    return;
  }

  try {
    const result =
      await processOAuthHealthAlert(
        consultantId,
      );

    if (!result.ok) {
      await scheduleRetry(
        consultantId,
      );

      return;
    }

    await removeJob(
      consultantId,
    );
  } catch (error) {
    console.error(
      "OAuth health alert processing failed",
      {
        consultantId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown processing error",
      },
    );

    await scheduleRetry(
      consultantId,
    );
  } finally {
    await releaseLock(
      consultantId,
      lock,
    );
  }
};

const runWorkerCycle = async (): Promise<void> => {
  if (cycleRunning) {
    return;
  }

  cycleRunning = true;

  try {
    await seedDueJobs();

    const dueConsultantIds =
      await redis.zrangebyscore(
        DUE_SET,
        "-inf",
        Date.now(),
        "LIMIT",
        0,
        BATCH_SIZE,
      );

    for (
      const consultantId of
      dueConsultantIds
    ) {
      await processDueAlert(
        consultantId,
      );
    }
  } catch (error) {
    console.error(
      "OAuth health alert worker cycle failed",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  } finally {
    cycleRunning = false;
  }
};

export const startOAuthHealthAlertWorker =
  (): void => {
    if (workerInterval) {
      return;
    }

    void runWorkerCycle();

    workerInterval =
      setInterval(
        () => {
          void runWorkerCycle();
        },
        POLL_INTERVAL_MS,
      );
  };

export const stopOAuthHealthAlertWorker =
  async (): Promise<void> => {
    if (workerInterval) {
      clearInterval(
        workerInterval,
      );

      workerInterval = null;
    }

    while (cycleRunning) {
      await new Promise<void>(
        (resolve) => {
          setTimeout(
            resolve,
            50,
          );
        },
      );
    }
  };
