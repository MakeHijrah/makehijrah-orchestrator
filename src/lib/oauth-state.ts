import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../config/env.js";

const STATE_VERSION = "v1";
const STATE_TTL_SECONDS = 10 * 60;

type OAuthStatePayload = {
  version: typeof STATE_VERSION;
  consultant_id: string;
  issued_at: number;
  expires_at: number;
  nonce: string;
};

const encode = (value: string): string => {
  return Buffer.from(value, "utf8").toString("base64url");
};

const decode = (value: string): string => {
  return Buffer.from(value, "base64url").toString("utf8");
};

const sign = (encodedPayload: string): string => {
  return createHmac(
    "sha256",
    env.OAUTH_STATE_SECRET,
  )
    .update(encodedPayload)
    .digest("base64url");
};

export const createOAuthState = (
  consultantId: string,
): string => {
  const issuedAt = Math.floor(Date.now() / 1000);

  const payload: OAuthStatePayload = {
    version: STATE_VERSION,
    consultant_id: consultantId,
    issued_at: issuedAt,
    expires_at: issuedAt + STATE_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  };

  const encodedPayload = encode(
    JSON.stringify(payload),
  );

  const signature = sign(encodedPayload);

  return `${encodedPayload}.${signature}`;
};

export const verifyOAuthState = (
  state: string,
): OAuthStatePayload | null => {
  const parts = state.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, suppliedSignature] = parts;

  if (!encodedPayload || !suppliedSignature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);

  const suppliedBuffer = Buffer.from(
    suppliedSignature,
    "base64url",
  );

  const expectedBuffer = Buffer.from(
    expectedSignature,
    "base64url",
  );

  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(
      suppliedBuffer,
      expectedBuffer,
    )
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      decode(encodedPayload),
    );

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);

    if (
      payload.version !== STATE_VERSION ||
      typeof payload.consultant_id !== "string" ||
      typeof payload.issued_at !== "number" ||
      typeof payload.expires_at !== "number" ||
      typeof payload.nonce !== "string" ||
      payload.expires_at <= now ||
      payload.issued_at > now
    ) {
      return null;
    }

    return payload as OAuthStatePayload;
  } catch {
    return null;
  }
};
