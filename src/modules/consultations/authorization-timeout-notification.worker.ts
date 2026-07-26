import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.js";
import {
  AUTHORIZATION_TIMEOUT_NOTIFICATION_DUE_SET,
  AUTHORIZATION_TIMEOUT_NOTIFICATION_LOCK_PREFIX,
  processAuthorizationTimeoutNotification,
} from "./authorization-timeout-notification.service.js";

const POLL_INTERVAL_MS = 10_000;
const RETRY_DELAY_MS = 60_000;
const LOCK_TTL_SECONDS = 120;
const BATCH_SIZE = 20;

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
    `${AUTHORIZATION_TIMEOUT_NOTIFICATION_LOCK_PREFIX}${consultationId}`;

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
      "Authorization timeout notification lock acquisition failed",
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
      "Authorization timeout notification lock release failed",
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
      AUTHORIZATION_TIMEOUT_NOTIFICATION_DUE_SET,
      consultationId,
    );
  } catch (error) {
    console.error(
      "Authorization timeout notification job removal failed",
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
      AUTHORIZATION_TIMEOUT_NOTIFICATION_DUE_SET,
      retryAt,
      consultationId,
    );
  } catch (error) {
    console.error(
      "Authorization timeout notification retry scheduling failed",
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

const processDueNotification =
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
        await processAuthorizationTimeoutNotification(
          consultationId,
        );

      if (
        result.ok &&
        result.action === "remove"
      ) {
        await removeJob(
          consultationId,
        );

        return;
      }

      await retryJob(
        consultationId,
      );
    } catch (error) {
      console.error(
        "Authorization timeout notification processing failed",
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
      const dueConsultationIds =
        await redis.zrangebyscore(
          AUTHORIZATION_TIMEOUT_NOTIFICATION_DUE_SET,
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
        await processDueNotification(
          consultationId,
        );
      }
    } catch (error) {
      console.error(
        "Authorization timeout notification worker cycle failed",
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

export const startAuthorizationTimeoutNotificationWorker =
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

export const stopAuthorizationTimeoutNotificationWorker =
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