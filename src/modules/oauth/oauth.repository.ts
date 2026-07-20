import { encryptOAuthToken } from "../../lib/oauth-token-crypto.js";
import { supabaseAdmin } from "../../lib/supabase.js";

type SaveGoogleConnectionInput = {
  consultantId: string;
  refreshToken: string;
  googleEmail: string;
  scopes: string[];
};

export type SaveGoogleConnectionResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

export const saveGoogleConnection = async ({
  consultantId,
  refreshToken,
  googleEmail,
  scopes,
}: SaveGoogleConnectionInput): Promise<SaveGoogleConnectionResult> => {
  let encryptedRefreshToken: string;

  try {
    encryptedRefreshToken = encryptOAuthToken(refreshToken);
  } catch (error) {
    console.error(
      "Google refresh token encryption failed:",
      error instanceof Error ? error.message : error,
    );

    return {
      ok: false,
      message: "Google connection could not be secured.",
    };
  }

  const now = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("oauth_connections")
    .upsert(
      {
        consultant_id: consultantId,
        provider: "google",
        encrypted_refresh_token: encryptedRefreshToken,
        google_email: googleEmail,
        scopes,
        connected_at: now,
        revoked_at: null,
        updated_at: now,
      },
      {
        onConflict: "consultant_id",
      },
    );

  if (error) {
    console.error("Google connection storage failed:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    return {
      ok: false,
      message: "Google connection could not be saved.",
    };
  }

  return {
    ok: true,
  };
};
