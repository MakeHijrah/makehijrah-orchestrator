import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import argon2 from "argon2";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import type {
  CreateConsultantInviteInput,
  RedeemConsultantInviteInput,
} from "./invite.schema.js";

type ConsultantInviteRow = {
  id: string;
  email: string;
  token_hash: string;
  status:
    | "unused"
    | "used"
    | "expired"
    | "revoked";
  expires_at: string;
};

type RedeemRpcRow = {
  result_code: string;
  profile_id: string | null;
  consultant_id: string | null;
  profile_role:
    | "client"
    | "consultant"
    | "admin"
    | null;
  consultant_is_active: boolean | null;
};

export type CreateConsultantInviteResult =
  | {
      ok: true;
      inviteId: string;
      inviteUrl: string;
      expiresAt: string;
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

export type RedeemConsultantInviteResult =
  | {
      ok: true;
      profileId: string;
      consultantId: string;
      role: "consultant";
      isActive: false;
    }
  | {
      ok: false;
      code:
        | "INVITE_INVALID"
        | "INVITE_EXPIRED"
        | "FORBIDDEN"
        | "INTERNAL_ERROR";
      message: string;
    };

const normalizeEmail = (
  value: string,
): string =>
  value.trim().toLowerCase();

const buildRawInviteToken = (
  inviteId: string,
): string => {
  /*
   * The UUID provides a bounded database lookup key.
   * The random secret provides the required 256 bits of entropy.
   *
   * The complete value is treated as the raw invite token.
   */
  const secret = randomBytes(32).toString(
    "base64url",
  );

  return `${inviteId}.${secret}`;
};

const parseInviteId = (
  rawToken: string,
): string | null => {
  const separatorIndex =
    rawToken.indexOf(".");

  if (
    separatorIndex <= 0 ||
    separatorIndex ===
      rawToken.length - 1
  ) {
    return null;
  }

  const inviteId =
    rawToken.slice(
      0,
      separatorIndex,
    );

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  return uuidPattern.test(inviteId)
    ? inviteId
    : null;
};

const appBaseUrl =
  env.APP_URL.replace(/\/+$/, "");

export const createConsultantInvite =
  async ({
    input,
    adminProfileId,
  }: {
    input: CreateConsultantInviteInput;
    adminProfileId: string;
  }): Promise<CreateConsultantInviteResult> => {
    const inviteId = randomUUID();
    const rawToken =
      buildRawInviteToken(inviteId);

    let tokenHash: string;

    try {
      tokenHash = await argon2.hash(
        rawToken,
        {
          type: argon2.argon2id,
        },
      );
    } catch (error) {
      console.error(
        "Consultant invite token hashing failed",
        {
          inviteId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Argon2 error",
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation could not be created.",
      };
    }

    const expiresAt = new Date(
      Date.now() +
        input.expires_in_days *
          24 *
          60 *
          60 *
          1000,
    ).toISOString();

    const { error } =
      await supabaseAdmin
        .from("consultant_invites")
        .insert({
          id: inviteId,
          email: normalizeEmail(
            input.email,
          ),
          token_hash: tokenHash,
          status: "unused",
          expires_at: expiresAt,
          created_by:
            adminProfileId,
        });

    if (error) {
      /*
       * Never include the raw token, token hash, or invited
       * email in logs.
       */
      console.error(
        "Consultant invite insert failed",
        {
          inviteId,
          adminProfileId,
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation could not be created.",
      };
    }

    return {
      ok: true,
      inviteId,
      inviteUrl:
        `${appBaseUrl}/onboard/${encodeURIComponent(
          rawToken,
        )}`,
      expiresAt,
    };
  };

const loadInviteForVerification =
  async (
    inviteId: string,
  ): Promise<
    | {
        ok: true;
        invite:
          ConsultantInviteRow | null;
      }
    | {
        ok: false;
      }
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultant_invites")
        .select(
          "id, email, token_hash, status, expires_at",
        )
        .eq("id", inviteId)
        .maybeSingle();

    if (error) {
      console.error(
        "Consultant invite lookup failed",
        {
          inviteId,
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
      };
    }

    return {
      ok: true,
      invite:
        data as ConsultantInviteRow | null,
    };
  };

const verifyInviteToken =
  async ({
    rawToken,
    tokenHash,
    inviteId,
  }: {
    rawToken: string;
    tokenHash: string;
    inviteId: string;
  }): Promise<boolean> => {
    try {
      return await argon2.verify(
        tokenHash,
        rawToken,
        {
          type: argon2.argon2id,
        },
      );
    } catch (error) {
      console.error(
        "Consultant invite token verification failed",
        {
          inviteId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Argon2 error",
        },
      );

      return false;
    }
  };

const mapRpcFailure = (
  resultCode: string,
): RedeemConsultantInviteResult => {
  switch (resultCode) {
    case "INVITE_EXPIRED":
      return {
        ok: false,
        code: "INVITE_EXPIRED",
        message:
          "This consultant invitation has expired.",
      };

    case "FORBIDDEN":
      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          "This invitation cannot be applied to the authenticated account.",
      };

    case "INVITE_INVALID":
    case "VALIDATION_ERROR":
      return {
        ok: false,
        code: "INVITE_INVALID",
        message:
          "This consultant invitation is invalid or is no longer available.",
      };

    default:
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation could not be redeemed.",
      };
  }
};

export const redeemConsultantInvite =
  async ({
    input,
    authenticatedProfileId,
  }: {
    input: RedeemConsultantInviteInput;
    authenticatedProfileId: string;
  }): Promise<RedeemConsultantInviteResult> => {
    const inviteId =
      parseInviteId(input.token);

    if (!inviteId) {
      return {
        ok: false,
        code: "INVITE_INVALID",
        message:
          "This consultant invitation is invalid or is no longer available.",
      };
    }

    const lookupResult =
      await loadInviteForVerification(
        inviteId,
      );

    if (!lookupResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation could not be verified.",
      };
    }

    const { invite } =
      lookupResult;

    if (!invite) {
      return {
        ok: false,
        code: "INVITE_INVALID",
        message:
          "This consultant invitation is invalid or is no longer available.",
      };
    }

    const tokenIsValid =
      await verifyInviteToken({
        rawToken: input.token,
        tokenHash:
          invite.token_hash,
        inviteId,
      });

    if (!tokenIsValid) {
      return {
        ok: false,
        code: "INVITE_INVALID",
        message:
          "This consultant invitation is invalid or is no longer available.",
      };
    }

    if (
      invite.status === "expired" ||
      Date.parse(invite.expires_at) <=
        Date.now()
    ) {
      return {
        ok: false,
        code: "INVITE_EXPIRED",
        message:
          "This consultant invitation has expired.",
      };
    }

    if (invite.status !== "unused") {
      return {
        ok: false,
        code: "INVITE_INVALID",
        message:
          "This consultant invitation is invalid or is no longer available.",
      };
    }

    const { data, error } =
      await supabaseAdmin.rpc(
        "redeem_consultant_invite",
        {
          p_invite_id: inviteId,
          p_profile_id:
            authenticatedProfileId,
          p_full_name:
            input.profile.full_name,
          p_timezone:
            input.profile.timezone,
        },
      );

    if (error) {
      console.error(
        "Consultant invite redemption RPC failed",
        {
          inviteId,
          authenticatedProfileId,
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation could not be redeemed.",
      };
    }

    const rpcRows =
      data as RedeemRpcRow[] | null;

    const result =
      rpcRows?.[0];

    if (!result) {
      console.error(
        "Consultant invite redemption RPC returned no result",
        {
          inviteId,
          authenticatedProfileId,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation could not be redeemed.",
      };
    }

    if (result.result_code !== "OK") {
      return mapRpcFailure(
        result.result_code,
      );
    }

    if (
      !result.profile_id ||
      !result.consultant_id ||
      result.profile_role !==
        "consultant" ||
      result.consultant_is_active !==
        false
    ) {
      console.error(
        "Consultant invite redemption RPC returned malformed success data",
        {
          inviteId,
          authenticatedProfileId,
          resultCode:
            result.result_code,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation could not be redeemed.",
      };
    }

    return {
      ok: true,
      profileId:
        result.profile_id,
      consultantId:
        result.consultant_id,
      role: "consultant",
      isActive: false,
    };
  };