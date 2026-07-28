import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.js";
import {
  listOAuthHealthCandidates,
  processOAuthHealthCheck,
} from "./oauth-health.service.js";

const POLL_INTERVAL_MS =
  15 * 60 * 1000;

const RETRY_DELAY_MS =
  60 * 1000;

const LOCK_TTL_SECONDS =
  180;

const BATCH_SIZE = 25;

const OAUTH_HEALTH_DUE_SET =
  "oauth-health:due";

const OAUTH_HEALTH_LOCK_PREFIX =
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
    `${OAUTH_HEALTH_LOCK_PREFIX}${consultantId}`;

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

    if (result !== "OK") {
      return null;
    }

    return {
      key,
      token,
    };
  } catch (error) {
    console.error(
      "OAuth health lock acquisition failed",
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
      "OAuth health lock release failed",
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

const removeJob = async (
  consultantId: string,
): Promise<void> => {
  try {
    await redis.zrem(
      OAUTH_HEALTH_DUE_SET,
      consultantId,
    );
  } catch (error) {
    console.error(
      "OAuth health job removal failed",
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

const retryJob = async (
  consultantId: string,
): Promise<void> => {
  try {
    await redis.zadd(
      OAUTH_HEALTH_DUE_SET,
      Date.now() +
        RETRY_DELAY_MS,
      consultantId,
    );
  } catch (error) {
    console.error(
      "OAuth health retry scheduling failed",
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

const seedDueJobs =
  async (): Promise<void> => {
    const result =
      await listOAuthHealthCandidates(
        BATCH_SIZE,
      );

    if (!result.ok) {
      console.error(
        "OAuth health candidate seeding failed",
        {
          message:
            result.message,
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

    try {
      const pipeline =
        redis.multi();

      for (
        const consultantId of
        result.consultantIds
      ) {
        pipeline.zadd(
          OAUTH_HEALTH_DUE_SET,
          "NX",
          Date.now(),
          consultantId,
        );
      }

      await pipeline.exec();
    } catch (error) {
      console.error(
        "OAuth health job seeding failed",
        {
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );
    }
  };

const processDueHealthCheck =
  async (
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
        await processOAuthHealthCheck(
          consultantId,
        );

      if (!result.ok) {
        await retryJob(
          consultantId,
        );

        return;
      }

      await removeJob(
        consultantId,
      );
    } catch (error) {
      console.error(
        "OAuth health processing failed",
        {
          consultantId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown processing error",
        },
      );

      await retryJob(
        consultantId,
      );
    } finally {
      await releaseLock(
        consultantId,
        lock,
      );
    }
  };

const runWorkerCycle =
  async (): Promise<void> => {
    if (cycleRunning) {
      return;
    }

    cycleRunning = true;

    try {
      await seedDueJobs();

      const dueConsultantIds =
        await redis.zrangebyscore(
          OAUTH_HEALTH_DUE_SET,
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
        await processDueHealthCheck(
          consultantId,
        );
      }
    } catch (error) {
      console.error(
        "OAuth health worker cycle failed",
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

export const startOAuthHealthWorker =
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

export const stopOAuthHealthWorker =
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
