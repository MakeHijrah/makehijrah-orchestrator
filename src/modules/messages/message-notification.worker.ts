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

const acquireLock = async (
  messageId: string,
): Promise<boolean> => {
  const lockKey =
    `${MESSAGE_NOTIFICATION_LOCK_PREFIX}` +
    `${messageId}`;

  try {
    const result =
      await redis.set(
        lockKey,
        "1",
        "EX",
        LOCK_TTL_SECONDS,
        "NX",
      );

    return result === "OK";
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

    return false;
  }
};

const releaseLock = async (
  messageId: string,
): Promise<void> => {
  const lockKey =
    `${MESSAGE_NOTIFICATION_LOCK_PREFIX}` +
    `${messageId}`;

  try {
    await redis.del(lockKey);
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
    const lockAcquired =
      await acquireLock(
        messageId,
      );

    if (!lockAcquired) {
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
