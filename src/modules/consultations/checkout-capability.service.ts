import {
  createHash,
  randomBytes,
} from "node:crypto";
import { redis } from "../../lib/redis.js";

const CHECKOUT_CAPABILITY_PREFIX =
  "booking-checkout:";

const MINIMUM_TOKEN_TTL_SECONDS = 1;

type CheckoutCapabilityRecord = {
  consultation_id: string;
};

type CreateCheckoutCapabilityInput = {
  consultationId: string;
  holdExpiresAt: string;
};

export type CreateCheckoutCapabilityResult =
  | {
      ok: true;
      token: string;
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

export type ValidateCheckoutCapabilityResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      code:
        | "CHECKOUT_TOKEN_INVALID"
        | "INTERNAL_ERROR";
      message: string;
    };

const hashToken = (
  token: string,
): string =>
  createHash("sha256")
    .update(token)
    .digest("hex");

const capabilityKey = (
  token: string,
): string =>
  `${CHECKOUT_CAPABILITY_PREFIX}${hashToken(token)}`;

const calculateTtlSeconds = (
  holdExpiresAt: string,
): number | null => {
  const expirationTime =
    Date.parse(holdExpiresAt);

  if (!Number.isFinite(expirationTime)) {
    return null;
  }

  const remainingMilliseconds =
    expirationTime - Date.now();

  const remainingSeconds = Math.floor(
    remainingMilliseconds / 1000,
  );

  if (
    remainingSeconds <
    MINIMUM_TOKEN_TTL_SECONDS
  ) {
    return null;
  }

  return remainingSeconds;
};

const parseCapabilityRecord = (
  value: string,
): CheckoutCapabilityRecord | null => {
  try {
    const parsed = JSON.parse(
      value,
    ) as Partial<CheckoutCapabilityRecord>;

    if (
      typeof parsed.consultation_id !==
        "string" ||
      parsed.consultation_id.length === 0
    ) {
      return null;
    }

    return {
      consultation_id:
        parsed.consultation_id,
    };
  } catch {
    return null;
  }
};

export const createCheckoutCapability =
  async ({
    consultationId,
    holdExpiresAt,
  }: CreateCheckoutCapabilityInput): Promise<CreateCheckoutCapabilityResult> => {
    const ttlSeconds =
      calculateTtlSeconds(
        holdExpiresAt,
      );

    if (!ttlSeconds) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The checkout capability could not be created.",
      };
    }

    const token = randomBytes(
      32,
    ).toString("base64url");

    const key = capabilityKey(token);

    const value: CheckoutCapabilityRecord = {
      consultation_id:
        consultationId,
    };

    try {
      await redis.set(
        key,
        JSON.stringify(value),
        "EX",
        ttlSeconds,
      );

      return {
        ok: true,
        token,
      };
    } catch (error) {
      console.error(
        "Checkout capability creation failed",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The checkout capability could not be created.",
      };
    }
  };

export const validateCheckoutCapability =
  async ({
    consultationId,
    token,
  }: {
    consultationId: string;
    token: string;
  }): Promise<ValidateCheckoutCapabilityResult> => {
    if (
      typeof token !== "string" ||
      token.length === 0
    ) {
      return {
        ok: false,
        code: "CHECKOUT_TOKEN_INVALID",
        message:
          "The checkout token is invalid or expired.",
      };
    }

    const key = capabilityKey(token);

    try {
      const storedValue =
        await redis.get(key);

      if (!storedValue) {
        return {
          ok: false,
          code:
            "CHECKOUT_TOKEN_INVALID",
          message:
            "The checkout token is invalid or expired.",
        };
      }

      const record =
        parseCapabilityRecord(
          storedValue,
        );

      if (
        !record ||
        record.consultation_id !==
          consultationId
      ) {
        return {
          ok: false,
          code:
            "CHECKOUT_TOKEN_INVALID",
          message:
            "The checkout token is invalid or expired.",
        };
      }

      return {
        ok: true,
      };
    } catch (error) {
      console.error(
        "Checkout capability validation failed",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The checkout token could not be verified.",
      };
    }
  };

export const consumeCheckoutCapability =
  async ({
    consultationId,
    token,
  }: {
    consultationId: string;
    token: string;
  }): Promise<ValidateCheckoutCapabilityResult> => {
    const validation =
      await validateCheckoutCapability({
        consultationId,
        token,
      });

    if (!validation.ok) {
      return validation;
    }

    const key = capabilityKey(token);

    try {
      const deleted =
        await redis.del(key);

      if (deleted !== 1) {
        return {
          ok: false,
          code:
            "CHECKOUT_TOKEN_INVALID",
          message:
            "The checkout token is invalid or expired.",
        };
      }

      return {
        ok: true,
      };
    } catch (error) {
      console.error(
        "Checkout capability consumption failed",
        {
          consultationId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Redis error",
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The checkout token could not be consumed.",
      };
    }
  };
