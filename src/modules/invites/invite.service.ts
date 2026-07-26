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

type UserRole =
  | "client"
  | "consultant"
  | "admin";

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

type ProvisionedInviteAccount = {
  profileId: string;
  authUserCreated: boolean;
};

type RedeemRpcRow = {
  result_code: string;
  profile_id: string | null;
  consultant_id: string | null;
  profile_role: UserRole | null;
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
      code:
        | "INVITEE_INELIGIBLE"
        | "INTERNAL_ERROR";
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

const findAuthUserByEmail =
  async (
    email: string,
  ): Promise<
    | {
        ok: true;
        userId: string | null;
      }
    | {
        ok: false;
      }
  > => {
    const perPage = 200;
    let page = 1;

    while (true) {
      const {
        data,
        error,
      } =
        await supabaseAdmin.auth.admin.listUsers({
          page,
          perPage,
        });

      if (error) {
        console.error(
          "Consultant invite auth-user lookup failed",
          {
            message: error.message,
            status: error.status,
          },
        );

        return {
          ok: false,
        };
      }

      const matchedUser =
        data.users.find(
          (user) =>
            normalizeEmail(
              user.email ?? "",
            ) === email,
        );

      if (matchedUser) {
        return {
          ok: true,
          userId: matchedUser.id,
        };
      }

      if (data.users.length < perPage) {
        return {
          ok: true,
          userId: null,
        };
      }

      page += 1;
    }
  };

const loadProfileRole =
  async (
    profileId: string,
  ): Promise<
    | {
        ok: true;
        role: UserRole | null;
      }
    | {
        ok: false;
      }
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("profiles")
        .select("role")
        .eq("id", profileId)
        .maybeSingle();

    if (error) {
      console.error(
        "Consultant invite profile lookup failed",
        {
          profileId,
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
      role:
        (data?.role as UserRole | undefined) ??
        null,
    };
  };

const waitForProfileRole =
  async (
    profileId: string,
  ): Promise<
    | {
        ok: true;
        role: UserRole;
      }
    | {
        ok: false;
      }
  > => {
    const attempts = 10;
    const delayMilliseconds = 100;

    for (
      let attempt = 1;
      attempt <= attempts;
      attempt += 1
    ) {
      const profileResult =
        await loadProfileRole(profileId);

      if (!profileResult.ok) {
        return {
          ok: false,
        };
      }

      if (profileResult.role) {
        return {
          ok: true,
          role: profileResult.role,
        };
      }

      if (attempt < attempts) {
        await new Promise<void>(
          (resolve) => {
            setTimeout(
              resolve,
              delayMilliseconds,
            );
          },
        );
      }
    }

    return {
      ok: false,
    };
  };

const deleteNewAuthUser =
  async (
    userId: string,
  ): Promise<void> => {
    const { error } =
      await supabaseAdmin.auth.admin.deleteUser(
        userId,
      );

    if (error) {
      console.error(
        "Consultant invite Auth-user cleanup failed",
        {
          userId,
          message: error.message,
          status: error.status,
        },
      );
    }
  };

const provisionInviteAccount =
  async (
    email: string,
  ): Promise<
    | {
        ok: true;
        account: ProvisionedInviteAccount;
      }
    | {
        ok: false;
        code:
          | "INVITEE_INELIGIBLE"
          | "INTERNAL_ERROR";
        message: string;
      }
  > => {
    const lookupResult =
      await findAuthUserByEmail(email);

    if (!lookupResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation account could not be prepared.",
      };
    }

    let profileId =
      lookupResult.userId;

    let authUserCreated = false;

    if (!profileId) {
      const {
        data,
        error,
      } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          email_confirm: false,
        });

      if (error || !data.user) {
        console.error(
          "Consultant invite Auth-user creation failed",
          {
            message: error?.message,
            status: error?.status,
          },
        );

        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The consultant invitation account could not be prepared.",
        };
      }

      profileId = data.user.id;
      authUserCreated = true;
    }

    const profileResult =
      await waitForProfileRole(
        profileId,
      );

    if (!profileResult.ok) {
      if (authUserCreated) {
        await deleteNewAuthUser(
          profileId,
        );
      }

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitation profile could not be prepared.",
      };
    }

    if (
      profileResult.role === "admin" ||
      profileResult.role ===
        "consultant"
    ) {
      if (authUserCreated) {
        await deleteNewAuthUser(
          profileId,
        );
      }

      return {
        ok: false,
        code: "INVITEE_INELIGIBLE",
        message:
          "This email cannot receive a consultant invitation.",
      };
    }

    return {
      ok: true,
      account: {
        profileId,
        authUserCreated,
      },
    };
  };

export const createConsultantInvite =
  async ({
    input,
    adminProfileId,
  }: {
    input: CreateConsultantInviteInput;
    adminProfileId: string;
  }): Promise<CreateConsultantInviteResult> => {
    const normalizedEmail =
      normalizeEmail(input.email);

    const provisioningResult =
      await provisionInviteAccount(
        normalizedEmail,
      );

    if (!provisioningResult.ok) {
      return provisioningResult;
    }

    const {
      profileId,
      authUserCreated,
    } =
      provisioningResult.account;

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

      if (authUserCreated) {
        await deleteNewAuthUser(
          profileId,
        );
      }

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
          email: normalizedEmail,
          token_hash: tokenHash,
          status: "unused",
          expires_at: expiresAt,
          created_by:
            adminProfileId,
        });

    if (error) {
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

      if (authUserCreated) {
        await deleteNewAuthUser(
          profileId,
        );
      }

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