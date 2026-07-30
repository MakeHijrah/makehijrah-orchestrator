/*
 * Redis primitives for the admin service catalog.
 *
 * Two independent concerns live here:
 *
 * - a per-service mutex serialising mutations of one service;
 * - the create idempotency record required by PROJECT_LOCK
 *   Amendment 004 section 14.3.7, which makes a repeated POST
 *   safe without a database table or a migration.
 */

import {
  createHash,
  randomUUID,
} from "node:crypto";
import { redis } from "../../lib/redis.js";

const SERVICE_LOCK_PREFIX =
  "service:admin:lock:";

/*
 * The Stripe client allows a 20 second timeout with two network
 * retries, so a single call can outlive a 30 second lock. 60
 * seconds covers the realistic worst case for one call.
 *
 * A lock that expires mid-sequence is survivable rather than
 * corrupting: every Stripe create carries a deterministic
 * idempotency key and every resume reconciles from the database
 * row, so two overlapping runners converge on the same resources
 * instead of duplicating them.
 */
const SERVICE_LOCK_TTL_SECONDS = 60;

const CREATE_IDEMPOTENCY_PREFIX =
  "service:create:";

/*
 * 48 hours, deliberately longer than Stripe's own 24 hour
 * idempotency window. If the two expired together, a resume just
 * after 24 hours would find no record, claim a fresh key and
 * insert a second service row, which is the exact duplicate this
 * record exists to prevent. Row identity must outlive Stripe
 * level de-duplication.
 */
const CREATE_IDEMPOTENCY_TTL_SECONDS = 172_800;

const LEASE_SECONDS = 60;

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end

  return 0
`;

/*
 * Compare-and-set on the exact stored string.
 *
 * Comparing the whole serialized record avoids parsing JSON
 * inside Lua and gives the strongest guarantee available: a write
 * lands only if nothing has changed since the caller read it. It
 * is what stops one worker overwriting another worker's active
 * lease after a takeover.
 */
const COMPARE_AND_SET_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3])
    return 1
  end

  return 0
`;

export type ServiceLock = {
  key: string;
  token: string;
};

export type AcquireServiceLockResult =
  | {
      ok: true;
      lock: ServiceLock;
    }
  | {
      ok: false;
      reason:
        | "contended"
        | "unavailable";
    };

export const acquireServiceLock =
  async (
    serviceId: string,
  ): Promise<AcquireServiceLockResult> => {
    const key = `${SERVICE_LOCK_PREFIX}${serviceId}`;

    const token = randomUUID();

    try {
      const result = await redis.set(
        key,
        token,
        "EX",
        SERVICE_LOCK_TTL_SECONDS,
        "NX",
      );

      if (result !== "OK") {
        return {
          ok: false,
          reason: "contended",
        };
      }

      return {
        ok: true,
        lock: { key, token },
      };
    } catch (error) {
      console.error(
        "Admin service lock acquisition failed",
        {
          serviceId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return {
        ok: false,
        reason: "unavailable",
      };
    }
  };

export const releaseServiceLock =
  async (
    lock: ServiceLock,
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
        "Admin service lock release failed",
        {
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );
    }
  };

export type CreateIdempotencyStatus =
  | "in_progress"
  | "completed"
  | "recoverable_failure";

export type CreateIdempotencyFailureStage =
  | "insert"
  | "product"
  | "persist_product_id"
  | "price"
  | "link"
  | "persist"
  | null;

export type CreateIdempotencyRecord = {
  status: CreateIdempotencyStatus;
  request_hash: string;
  service_id: string | null;
  response: unknown;
  failure_stage: CreateIdempotencyFailureStage;
  lease_token: string;
  lease_expires_at: string;
  attempt: number;
  created_at: string;
  updated_at: string;
};

export type CreateIdempotencySession = {
  key: string;
  raw: string;
  record: CreateIdempotencyRecord;
};

export const buildCreateIdempotencyKey =
  ({
    adminProfileId,
    idempotencyKey,
  }: {
    adminProfileId: string;
    idempotencyKey: string;
  }): string => {
    const digest = createHash("sha256")
      .update(idempotencyKey)
      .digest("hex");

    return `${CREATE_IDEMPOTENCY_PREFIX}${adminProfileId}:${digest}`;
  };

const canonicalize = (
  value: unknown,
): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (
    typeof value === "object" &&
    value !== null
  ) {
    const source = value as Record<
      string,
      unknown
    >;

    return Object.keys(source)
      .sort()
      .reduce<
        Record<string, unknown>
      >((accumulator, key) => {
        accumulator[key] =
          canonicalize(source[key]);

        return accumulator;
      }, {});
  }

  return value;
};

/*
 * Hashed from the parsed body rather than the raw request, so
 * key order, incidental whitespace and an omitted optional versus
 * an explicit undefined cannot produce a false payload mismatch.
 */
export const hashCanonicalBody = (
  value: unknown,
): string => {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize(value),
      ) ?? "null",
    )
    .digest("hex");
};

export const buildLease = (): {
  lease_token: string;
  lease_expires_at: string;
} => {
  return {
    lease_token: randomUUID(),
    lease_expires_at: new Date(
      Date.now() +
        LEASE_SECONDS * 1000,
    ).toISOString(),
  };
};

export const isLeaseExpired = (
  record: CreateIdempotencyRecord,
): boolean => {
  const expiresAt = Date.parse(
    record.lease_expires_at,
  );

  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt <= Date.now();
};

const parseRecord = (
  raw: string,
): CreateIdempotencyRecord | null => {
  try {
    return JSON.parse(
      raw,
    ) as CreateIdempotencyRecord;
  } catch {
    return null;
  }
};

export type ClaimCreateIdempotencyResult =
  | {
      ok: true;
      session: CreateIdempotencySession;
    }
  | {
      ok: false;
      reason: "exists";
      raw: string;
      record: CreateIdempotencyRecord;
    }
  | {
      ok: false;
      reason: "unavailable";
    };

export const claimCreateIdempotency =
  async ({
    key,
    record,
  }: {
    key: string;
    record: CreateIdempotencyRecord;
  }): Promise<ClaimCreateIdempotencyResult> => {
    const raw = JSON.stringify(record);

    try {
      const claimed = await redis.set(
        key,
        raw,
        "EX",
        CREATE_IDEMPOTENCY_TTL_SECONDS,
        "NX",
      );

      if (claimed === "OK") {
        return {
          ok: true,
          session: {
            key,
            raw,
            record,
          },
        };
      }

      const existingRaw =
        await redis.get(key);

      if (!existingRaw) {
        /*
         * The record expired between the failed claim and this
         * read. Treated as unavailable rather than retried in
         * place, so a caller never silently races itself.
         */
        return {
          ok: false,
          reason: "unavailable",
        };
      }

      const existingRecord =
        parseRecord(existingRaw);

      if (!existingRecord) {
        console.error(
          "Admin service idempotency record could not be parsed",
          { key },
        );

        return {
          ok: false,
          reason: "unavailable",
        };
      }

      return {
        ok: false,
        reason: "exists",
        raw: existingRaw,
        record: existingRecord,
      };
    } catch (error) {
      console.error(
        "Admin service idempotency claim failed",
        {
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return {
        ok: false,
        reason: "unavailable",
      };
    }
  };

/*
 * Every state transition after the initial claim goes through
 * this, so a worker whose lease was taken over cannot write back
 * over its successor.
 */
export const compareAndSetIdempotency =
  async ({
    session,
    next,
  }: {
    session: CreateIdempotencySession;
    next: CreateIdempotencyRecord;
  }): Promise<boolean> => {
    const raw = JSON.stringify(next);

    try {
      const result =
        await redis.eval(
          COMPARE_AND_SET_SCRIPT,
          1,
          session.key,
          session.raw,
          raw,
          String(
            CREATE_IDEMPOTENCY_TTL_SECONDS,
          ),
        );

      if (result !== 1) {
        return false;
      }

      session.raw = raw;
      session.record = next;

      return true;
    } catch (error) {
      console.error(
        "Admin service idempotency write failed",
        {
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return false;
    }
  };
