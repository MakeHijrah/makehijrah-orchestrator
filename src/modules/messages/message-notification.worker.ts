import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.js";
import {
  MESSAGE_NOTIFICATION_DUE_SET,
  MESSAGE_NOTIFICATION_LOCK_PREFIX,
  processMessageNotification,
} from "./message-notification.service.js";

const POLL_INTERVAL_MS = 10_000;
const RETRY_DELAY_MS = 60_000;
const LOCK_TTL_SECONDS = 60;
const BATCH_SIZE = 25;

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
  messageId: string,
): Promise<AcquiredLock | null> => {
  const key =
    `${MESSAGE_NOTIFICATION_LOCK_PREFIX}` +
    `${messageId}`;

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
      "Message notification lock acquisition failed",
      {
        messageId,
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
  messageId: string,
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
      "Message notification lock release failed",
      {
        messageId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const removeJob = async (
  messageId: string,
): Promise<void> => {
  try {
    await redis.zrem(
      MESSAGE_NOTIFICATION_DUE_SET,
      messageId,
    );
  } catch (error) {
    console.error(
      "Message notification job removal failed",
      {
        messageId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const retryJob = async (
  messageId: string,
): Promise<void> => {
  const retryAt =
    Date.now() +
    RETRY_DELAY_MS;

  try {
    await redis.zadd(
      MESSAGE_NOTIFICATION_DUE_SET,
      retryAt,
      messageId,
    );
  } catch (error) {
    console.error(
      "Message notification retry scheduling failed",
      {
        messageId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Redis error",
      },
    );
  }
};

const processDueMessage =
  async (
    messageId: string,
  ): Promise<void> => {
    const lock =
      await acquireLock(
        messageId,
      );

    if (!lock) {
      return;
    }

    try {
      const result =
        await processMessageNotification(
          messageId,
        );

      if (
        result.ok &&
        result.action ===
          "remove"
      ) {
        await removeJob(
          messageId,
        );

        return;
      }

      await retryJob(
        messageId,
      );
    } catch (error) {
      console.error(
        "Message notification processing failed",
        {
          messageId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown processing error",
        },
      );

      await retryJob(
        messageId,
      );
    } finally {
      await releaseLock(
        messageId,
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
      const dueMessageIds =
        await redis.zrangebyscore(
          MESSAGE_NOTIFICATION_DUE_SET,
          "-inf",
          Date.now(),
          "LIMIT",
          0,
          BATCH_SIZE,
        );

      for (
        const messageId of
        dueMessageIds
      ) {
        await processDueMessage(
          messageId,
        );
      }
    } catch (error) {
      console.error(
        "Message notification worker cycle failed",
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

export const startMessageNotificationWorker =
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

export const stopMessageNotificationWorker =
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
