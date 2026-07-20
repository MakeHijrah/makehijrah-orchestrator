import { redis } from "../../lib/redis.js";
import type { BusyInterval } from "./availability.conflicts.js";

type StoredSlotHold = {
  hold_id: string;
  start_at: string;
  end_at: string;
};

export type HeldSlotIntervalsResult =
  | {
      ok: true;
      intervals: BusyInterval[];
    }
  | {
      ok: false;
      message: string;
    };

const holdKey = (consultantId: string): string => {
  return `availability:holds:${consultantId}`;
};

const parseStoredHold = (
  value: string,
): StoredSlotHold | null => {
  try {
    const parsed: unknown = JSON.parse(value);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const hold = parsed as Record<string, unknown>;

    if (
      typeof hold.hold_id !== "string" ||
      typeof hold.start_at !== "string" ||
      typeof hold.end_at !== "string"
    ) {
      return null;
    }

    const start = Date.parse(hold.start_at);
    const end = Date.parse(hold.end_at);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      return null;
    }

    return {
      hold_id: hold.hold_id,
      start_at: hold.start_at,
      end_at: hold.end_at,
    };
  } catch {
    return null;
  }
};

export const getHeldSlotIntervals = async (
  consultantId: string,
): Promise<HeldSlotIntervalsResult> => {
  const key = holdKey(consultantId);
  const nowEpochSeconds = Math.floor(Date.now() / 1000);

  try {
    const transaction = redis.multi();

    transaction.zremrangebyscore(
      key,
      "-inf",
      nowEpochSeconds,
    );

    transaction.zrange(
      key,
      nowEpochSeconds + 1,
      "+inf",
      "BYSCORE",
    );

    const results = await transaction.exec();

    if (!results) {
      return {
        ok: false,
        message: "Unable to check temporary booking holds.",
      };
    }

    const rangeResult = results[1];

    if (!rangeResult) {
      return {
        ok: true,
        intervals: [],
      };
    }

    const [rangeError, members] = rangeResult;

    if (rangeError) {
      console.error(
        "Redis held-slot lookup failed:",
        rangeError,
      );

      return {
        ok: false,
        message: "Unable to check temporary booking holds.",
      };
    }

    if (!Array.isArray(members)) {
      return {
        ok: true,
        intervals: [],
      };
    }

    const intervals: BusyInterval[] = [];

    for (const member of members) {
      if (typeof member !== "string") {
        continue;
      }

      const hold = parseStoredHold(member);

      if (!hold) {
        continue;
      }

      intervals.push({
        start_at: hold.start_at,
        end_at: hold.end_at,
      });
    }

    return {
      ok: true,
      intervals,
    };
  } catch (error) {
    console.error(
      "Redis held-slot lookup failed:",
      error instanceof Error ? error.message : error,
    );

    return {
      ok: false,
      message: "Unable to check temporary booking holds.",
    };
  }
};
