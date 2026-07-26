import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.js";
import {
  listAuthorizationTimeoutCandidates,
  processAuthorizationTimeout,
} from "./authorization-timeout.service.js";

const POLL_INTERVAL_MS =
  15 * 60 * 1000;

const RETRY_DELAY_MS =
  60 * 1000;

const LOCK_TTL_SECONDS =
  180;

const BATCH_SIZE = 25;

const AUTHORIZATION_TIMEOUT_DUE_SET =
  "authorization-timeout:due";

const AUTHORIZATION_TIMEOUT_LOCK_PREFIX =
  "authorization-timeout:lock:";

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
  consultationId: string,
): Promise<AcquiredLock | null> => {
  const key =
    `${AUTHORIZATION_TIMEOUT_LOCK_PREFIX}${consultationId}`;

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
      "Authorization timeout lock acquisition failed",
      {
        consultationId,
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
  consultationId: string,
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
      "Authorization timeout lock release failed",
      {
        consultationId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const removeJob = async (
  consultationId: string,
): Promise<void> => {
  try {
    await redis.zrem(
      AUTHORIZATION_TIMEOUT_DUE_SET,
      consultationId,
    );
  } catch (error) {
    console.error(
      "Authorization timeout job removal failed",
      {
        consultationId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const retryJob = async (
  consultationId: string,
): Promise<void> => {
  const retryAt =
    Date.now() +
    RETRY_DELAY_MS;

  try {
    await redis.zadd(
      AUTHORIZATION_TIMEOUT_DUE_SET,
      retryAt,
      consultationId,
    );
  } catch (error) {
    console.error(
      "Authorization timeout retry scheduling failed",
      {
        consultationId,
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
      await listAuthorizationTimeoutCandidates(
        BATCH_SIZE,
      );

    if (!result.ok) {
      console.error(
        "Authorization timeout candidate seeding failed",
        {
          message:
            result.message,
        },
      );

      return;
    }

    if (
      result.consultationIds.length ===
      0
    ) {
      return;
    }

    const now =
      Date.now();

    const args:
      Array<string | number> = [];

    for (
      const consultationId of
      result.consultationIds
    ) {
      args.push(
        "NX",
        now,
        consultationId,
      );
    }

    try {
      const pipeline =
        redis.multi();

      for (
        let index = 0;
        index < args.length;
        index += 3
      ) {
        pipeline.zadd(
          AUTHORIZATION_TIMEOUT_DUE_SET,
          args[index] as string,
          args[index + 1] as number,
          args[index + 2] as string,
        );
      }

      await pipeline.exec();
    } catch (error) {
      console.error(
        "Authorization timeout job seeding failed",
        {
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );
    }
  };

const processDueTimeout =
  async (
    consultationId: string,
  ): Promise<void> => {
    const lock =
      await acquireLock(
        consultationId,
      );

    if (!lock) {
      return;
    }

    try {
      const result =
        await processAuthorizationTimeout(
          consultationId,
        );

      if (!result.ok) {
        if (
          result.action ===
          "retry"
        ) {
          await retryJob(
            consultationId,
          );
        } else {
          await removeJob(
            consultationId,
          );
        }

        return;
      }

      await removeJob(
        consultationId,
      );
    } catch (error) {
      console.error(
        "Authorization timeout processing failed",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown processing error",
        },
      );

      await retryJob(
        consultationId,
      );
    } finally {
      await releaseLock(
        consultationId,
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

      const dueConsultationIds =
        await redis.zrangebyscore(
          AUTHORIZATION_TIMEOUT_DUE_SET,
          "-inf",
          Date.now(),
          "LIMIT",
          0,
          BATCH_SIZE,
        );

      for (
        const consultationId of
        dueConsultationIds
      ) {
        await processDueTimeout(
          consultationId,
        );
      }
    } catch (error) {
      console.error(
        "Authorization timeout worker cycle failed",
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

export const startAuthorizationTimeoutWorker =
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

export const stopAuthorizationTimeoutWorker =
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