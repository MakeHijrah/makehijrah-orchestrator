import { supabaseAdmin } from "../../lib/supabase.js";

type InviteStatus =
  | "unused"
  | "used"
  | "expired"
  | "revoked";

type InviteListRow = {
  id: string;
  email: string;
  status: InviteStatus;
  expires_at: string;
  created_at: string;
  used_at: string | null;
};

export type AdminInviteListItem = {
  inviteId: string;
  email: string;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  canCreateNew: boolean;
};

export type ListAdminInvitesResult =
  | {
      ok: true;
      invites: AdminInviteListItem[];
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

const expireStaleInvites =
  async (): Promise<boolean> => {
    const { error } =
      await supabaseAdmin
        .from("consultant_invites")
        .update({
          status: "expired",
        })
        .eq("status", "unused")
        .lte(
          "expires_at",
          new Date().toISOString(),
        );

    if (error) {
      console.error(
        "Consultant invite expiration refresh failed",
        {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return false;
    }

    return true;
  };

export const listAdminInvites =
  async (): Promise<ListAdminInvitesResult> => {
    const expirationUpdated =
      await expireStaleInvites();

    if (!expirationUpdated) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultant invitations could not be loaded.",
      };
    }

    const { data, error } =
      await supabaseAdmin
        .from("consultant_invites")
        .select(
          "id, email, status, expires_at, created_at, used_at",
        )
        .in("status", [
          "unused",
          "expired",
        ])
        .order("created_at", {
          ascending: false,
        });

    if (error) {
      console.error(
        "Consultant invite list lookup failed",
        {
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
          "The consultant invitations could not be loaded.",
      };
    }

    const rows =
      (data ?? []) as InviteListRow[];

    /*
     * Keep only the newest unused or expired invitation for each
     * normalized email. Older expired rows remain in the database
     * for audit history but do not clutter the admin interface.
     */
    const newestByEmail =
      new Map<string, InviteListRow>();

    for (const row of rows) {
      const normalizedEmail =
        row.email.trim().toLowerCase();

      if (
        !newestByEmail.has(
          normalizedEmail,
        )
      ) {
        newestByEmail.set(
          normalizedEmail,
          row,
        );
      }
    }

    const invites =
      Array.from(
        newestByEmail.values(),
      ).map(
        (
          row,
        ): AdminInviteListItem => ({
          inviteId: row.id,
          email: row.email,
          status: row.status,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          usedAt: row.used_at,
          canCreateNew:
            row.status === "expired",
        }),
      );

    return {
      ok: true,
      invites,
    };
  };