import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

const encryptionKey = Buffer.from(
  env.OAUTH_TOKEN_ENCRYPTION_KEY,
  "base64",
);

const toBase64Url = (value: Buffer): string => {
  return value.toString("base64url");
};

const fromBase64Url = (value: string): Buffer => {
  return Buffer.from(value, "base64url");
};

export const encryptOAuthToken = (
  plaintextToken: string,
): string => {
  if (!plaintextToken.trim()) {
    throw new Error("OAuth token cannot be empty.");
  }

  const iv = randomBytes(IV_LENGTH_BYTES);

  const cipher = createCipheriv(
    ALGORITHM,
    encryptionKey,
    iv,
    {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    },
  );

  const encrypted = Buffer.concat([
    cipher.update(plaintextToken, "utf8"),
    cipher.final(),
  ]);

  const authenticationTag = cipher.getAuthTag();

  return [
    VERSION,
    toBase64Url(iv),
    toBase64Url(authenticationTag),
    toBase64Url(encrypted),
  ].join(".");
};

export const decryptOAuthToken = (
  encryptedToken: string,
): string => {
  const parts = encryptedToken.split(".");

  if (parts.length !== 4) {
    throw new Error("Encrypted OAuth token format is invalid.");
  }

  const [
    version,
    encodedIv,
    encodedAuthenticationTag,
    encodedCiphertext,
  ] = parts;

  if (
    version !== VERSION ||
    !encodedIv ||
    !encodedAuthenticationTag ||
    !encodedCiphertext
  ) {
    throw new Error("Encrypted OAuth token format is invalid.");
  }

  const iv = fromBase64Url(encodedIv);
  const authenticationTag = fromBase64Url(
    encodedAuthenticationTag,
  );
  const ciphertext = fromBase64Url(encodedCiphertext);

  if (
    iv.length !== IV_LENGTH_BYTES ||
    authenticationTag.length !== AUTH_TAG_LENGTH_BYTES
  ) {
    throw new Error("Encrypted OAuth token data is invalid.");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey,
    iv,
    {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    },
  );

  decipher.setAuthTag(authenticationTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};
