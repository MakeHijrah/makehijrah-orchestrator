import { redis } from "../../lib/redis.js";
import type { AvailabilityResult } from "./availability.types.js";

const CACHE_TTL_SECONDS = 120;

const cacheKey = (
  consultantId: string,
  from: string,
  to: string,
): string => {
  return [
    "availability",
    "cache",
    consultantId,
    encodeURIComponent(from),
    encodeURIComponent(to),
  ].join(":");
};

const isAvailabilityResult = (
  value: unknown,
): value is AvailabilityResult => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const result = value as Record<string, unknown>;

  return (
    typeof result.consultant_id === "string" &&
    Array.isArray(result.slots) &&
    typeof result.generated_at === "string" &&
    result.cache_ttl_seconds === CACHE_TTL_SECONDS &&
    (
      result.availability_mode === "normal" ||
      result.availability_mode === "degraded"
    ) &&
    typeof result.calendar_connected === "boolean"
  );
};

export const getCachedAvailability = async (
  consultantId: string,
  from: string,
  to: string,
): Promise<AvailabilityResult | null> => {
  try {
    const stored = await redis.get(
      cacheKey(consultantId, from, to),
    );

    if (!stored) {
      return null;
    }

    const parsed: unknown = JSON.parse(stored);

    return isAvailabilityResult(parsed) ? parsed : null;
  } catch (error) {
    console.error(
      "Availability cache read failed:",
      error instanceof Error ? error.message : error,
    );

    return null;
  }
};

export const setCachedAvailability = async (
  consultantId: string,
  from: string,
  to: string,
  result: AvailabilityResult,
): Promise<void> => {
  try {
    await redis.set(
      cacheKey(consultantId, from, to),
      JSON.stringify(result),
      "EX",
      CACHE_TTL_SECONDS,
    );
  } catch (error) {
    console.error(
      "Availability cache write failed:",
      error instanceof Error ? error.message : error,
    );
  }
};

export const clearConsultantAvailabilityCache = async (
  consultantId: string,
): Promise<void> => {
  const pattern = `availability:cache:${consultantId}:*`;

  try {
    let cursor = "0";

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );

      cursor = nextCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch (error) {
    console.error(
      "Availability cache clearing failed:",
      error instanceof Error ? error.message : error,
    );
  }
};
