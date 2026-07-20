import type { FastifyRequest } from "fastify";
import { supabaseAdmin } from "./supabase.js";

export type AuthenticatedProfile = {
  id: string;
  role: "client" | "consultant" | "admin";
  email: string | null;
};

export type AuthenticationResult =
  | {
      ok: true;
      profile: AuthenticatedProfile;
    }
  | {
      ok: false;
      statusCode: 401 | 403 | 500;
      code:
        | "UNAUTHORIZED"
        | "FORBIDDEN"
        | "INTERNAL_ERROR";
      message: string;
    };

const extractBearerToken = (
  authorizationHeader: string | undefined,
): string | null => {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(
    /^Bearer\s+(.+)$/i,
  );

  const token = match?.[1]?.trim();

  return token || null;
};

export const authenticateRequest = async (
  request: FastifyRequest,
): Promise<AuthenticationResult> => {
  const accessToken = extractBearerToken(
    request.headers.authorization,
  );

  if (!accessToken) {
    return {
      ok: false,
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Authentication is required.",
    };
  }

  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(accessToken);

  if (userError || !user) {
    return {
      ok: false,
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "The authentication token is invalid or expired.",
    };
  }

  const { data: profile, error: profileError } =
    await supabaseAdmin
      .from("profiles")
      .select("id, role, email")
      .eq("id", user.id)
      .maybeSingle();

  if (profileError) {
    request.log.error(
      {
        profileError: {
          code: profileError.code,
          message: profileError.message,
          details: profileError.details,
          hint: profileError.hint,
        },
        userId: user.id,
      },
      "Authenticated profile lookup failed",
    );

    return {
      ok: false,
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Unable to verify the authenticated account.",
    };
  }

  if (!profile) {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN",
      message: "The authenticated profile was not found.",
    };
  }

  if (
    profile.role !== "client" &&
    profile.role !== "consultant" &&
    profile.role !== "admin"
  ) {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN",
      message: "The authenticated account role is invalid.",
    };
  }

  return {
    ok: true,
    profile: {
      id: profile.id,
      role: profile.role,
      email: profile.email,
    },
  };
};

export const requireRole = async (
  request: FastifyRequest,
  allowedRoles: AuthenticatedProfile["role"][],
): Promise<AuthenticationResult> => {
  const authentication = await authenticateRequest(request);

  if (!authentication.ok) {
    return authentication;
  }

  if (!allowedRoles.includes(authentication.profile.role)) {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN",
      message:
        "You do not have permission to perform this action.",
    };
  }

  return authentication;
};
