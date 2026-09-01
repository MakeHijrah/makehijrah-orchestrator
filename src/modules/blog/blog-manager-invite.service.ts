import { env } from "../../config/env.js";
import {
  sendTransactionalEmail,
} from "../../lib/mandrill.js";
import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Granting blog access to an address that has no account.
 *
 * The frontend signs in with signInWithOtp and
 * shouldCreateUser: false, and there is no public sign-up. That
 * flag cannot be relaxed conditionally — the client chooses it, so
 * anyone could call Supabase directly with true — which makes
 * account creation something only the service role can do, and
 * therefore something only this process can do.
 *
 * No invite token and no onboarding route. Once the account
 * exists the person signs in through the ordinary OTP flow; a
 * token would add an expiry, a consumption record and a route to
 * achieve exactly what the login already does.
 */

const PROFILE_WAIT_ATTEMPTS = 10;
const PROFILE_WAIT_DELAY_MILLISECONDS = 100;

export type BlogManagerGrant = {
  id: string;
  email: string;
  profile_id: string;
  note: string | null;
  granted_at: string;
  account_created: boolean;
  email_sent: boolean;
};

export type InviteBlogManagerResult =
  | {
      ok: true;
      grant: BlogManagerGrant;
    }
  | {
      ok: false;
      code:
        | "VALIDATION_ERROR"
        | "INTERNAL_ERROR";
      reason: string;
      message: string;
    };

type GrantRow = {
  id: string;
  email: string;
  profile_id: string | null;
  note: string | null;
  granted_at: string;
};

export const normalizeEmail = (
  value: string,
): string =>
  value.trim().toLowerCase();

/*
 * Deliberately permissive, and matched to what the database
 * already accepts: blog_managers.email is plain text with a
 * unique index on lower(btrim(email)) and no format constraint.
 * The address is proved by the OTP that has to be received, not
 * by a regex here.
 */
export const isUsableEmail = (
  value: string,
): boolean => {
  const normalized =
    normalizeEmail(value);

  if (
    normalized.length < 3 ||
    normalized.length > 320 ||
    /\s/.test(normalized)
  ) {
    return false;
  }

  const parts =
    normalized.split("@");

  if (parts.length !== 2) {
    return false;
  }

  const [local, domain] = parts;

  return (
    (local?.length ?? 0) > 0 &&
    (domain?.length ?? 0) > 2 &&
    domain!.includes(".") &&
    !domain!.startsWith(".") &&
    !domain!.endsWith(".")
  );
};

const sleep = async (
  milliseconds: number,
): Promise<void> => {
  await new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        milliseconds,
      );
    },
  );
};

/*
 * Mirrors the paging lookup in invite.service.ts and
 * booking-client.service.ts rather than reading profiles by
 * email: auth.users is the authority on whether an account
 * exists, and an auth user whose profile row failed to be created
 * would otherwise be missed and then collide on createUser.
 */
const findAuthUserByEmail = async (
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
        "Blog manager invite auth-user lookup failed",
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

    if (
      data.users.length < perPage
    ) {
      return {
        ok: true,
        userId: null,
      };
    }

    page += 1;
  }
};

/*
 * handle_new_user creates the profile row on an AFTER INSERT
 * trigger, so it may not be visible the instant createUser
 * returns. Waits for it exactly as the consultant invite does.
 *
 * The role is read but never written: a blog manager keeps
 * whatever role they have, and a new account stays 'client'.
 * Blog access is the grant, not the role.
 */
const waitForProfile = async (
  profileId: string,
): Promise<boolean> => {
  for (
    let attempt = 1;
    attempt <= PROFILE_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    const {
      data,
      error,
    } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", profileId)
      .maybeSingle();

    if (error) {
      console.error(
        "Blog manager invite profile lookup failed",
        {
          profileId,
          code: error.code,
          message: error.message,
        },
      );

      return false;
    }

    if (data) {
      return true;
    }

    if (
      attempt < PROFILE_WAIT_ATTEMPTS
    ) {
      await sleep(
        PROFILE_WAIT_DELAY_MILLISECONDS,
      );
    }
  }

  return false;
};

const escapeHtml = (
  value: string,
): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const buildBlogManagerLoginUrl =
  (): string =>
    `${env.APP_URL.replace(
      /\/+$/,
      "",
    )}/login?redirect=%2Fblog%2Fadmin`;

const sendInviteEmail = async ({
  email,
}: {
  email: string;
}): Promise<boolean> => {
  const loginUrl =
    buildBlogManagerLoginUrl();

  /*
   * No password is mentioned anywhere, because there is not one.
   * Sign-in is a code sent to this address.
   */
  const result =
    await sendTransactionalEmail({
      to: {
        email,
      },
      subject:
        "You have been given access to the Make Hijrah blog",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
          <h1 style="font-family:Georgia,serif;color:#364355;">Blog access</h1>
          <p>As-salāmu ʿalaykum,</p>
          <p>You have been given access to write and manage posts on the Make Hijrah blog.</p>
          <p>Sign in with this email address — <strong>${escapeHtml(email)}</strong> — and we will send you a code to enter. There is no password to set.</p>
          <p>
            <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
              Open the blog admin
            </a>
          </p>
          <p>MakeHijrah</p>
        </div>
      `,
      text: [
        "As-salāmu ʿalaykum,",
        "",
        "You have been given access to write and manage posts on the Make Hijrah blog.",
        "",
        `Sign in with this email address — ${email} — and we will send you a code to enter. There is no password to set.`,
        "",
        `Open the blog admin: ${loginUrl}`,
        "",
        "MakeHijrah",
      ].join("\n"),
      tags: [
        "blog-manager-invite",
      ],
    });

  if (!result.ok) {
    console.error(
      "Blog manager invite email delivery failed",
      {
        message: result.message,
      },
    );

    return false;
  }

  return true;
};

/*
 * The unique index is on the EXPRESSION lower(btrim(email)), which
 * PostgREST cannot target with an upsert onConflict. So the grant
 * is resolved read-then-write, with the unique violation handled
 * as the race it is rather than as an error.
 */
const upsertGrant = async ({
  email,
  note,
  profileId,
  adminProfileId,
}: {
  email: string;
  note: string | null;
  profileId: string;
  adminProfileId: string;
}): Promise<GrantRow | null> => {
  const selectExisting = async (): Promise<
    GrantRow | null
  > => {
    const {
      data,
      error,
    } = await supabaseAdmin
      .from("blog_managers")
      .select(
        "id, email, profile_id, note, granted_at",
      )
      .eq("email", email)
      .maybeSingle();

    if (error) {
      console.error(
        "Blog manager grant lookup failed",
        {
          code: error.code,
          message: error.message,
        },
      );

      return null;
    }

    return (
      data as GrantRow | null
    );
  };

  const existing =
    await selectExisting();

  if (existing) {
    /*
     * A re-invite refreshes the link to the resolved profile and
     * the note, but never rewrites granted_by or granted_at: who
     * first granted access, and when, is a record worth keeping.
     */
    const {
      data,
      error,
    } = await supabaseAdmin
      .from("blog_managers")
      .update({
        profile_id: profileId,
        ...(note === null
          ? {}
          : { note }),
      })
      .eq("id", existing.id)
      .select(
        "id, email, profile_id, note, granted_at",
      )
      .maybeSingle();

    if (error) {
      console.error(
        "Blog manager grant update failed",
        {
          grantId: existing.id,
          code: error.code,
          message: error.message,
        },
      );

      return null;
    }

    return (
      data as GrantRow | null
    );
  }

  const {
    data,
    error,
  } = await supabaseAdmin
    .from("blog_managers")
    .insert({
      email,
      profile_id: profileId,
      granted_by: adminProfileId,
      ...(note === null
        ? {}
        : { note }),
    })
    .select(
      "id, email, profile_id, note, granted_at",
    )
    .maybeSingle();

  if (error) {
    /*
     * Two admins pressing invite at the same moment. The index
     * did its job; re-read and return the row that won.
     */
    if (error.code === "23505") {
      return selectExisting();
    }

    console.error(
      "Blog manager grant insert failed",
      {
        code: error.code,
        message: error.message,
      },
    );

    return null;
  }

  return data as GrantRow | null;
};

export const inviteBlogManager =
  async ({
    email,
    note,
    adminProfileId,
  }: {
    email: string;
    note: string | null;
    adminProfileId: string;
  }): Promise<InviteBlogManagerResult> => {
    const normalizedEmail =
      normalizeEmail(email);

    if (
      !isUsableEmail(
        normalizedEmail,
      )
    ) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        reason: "invalid_email",
        message:
          "That email address is not valid.",
      };
    }

    const lookupResult =
      await findAuthUserByEmail(
        normalizedEmail,
      );

    if (!lookupResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        reason:
          "account_lookup_failed",
        message:
          "The blog access could not be granted.",
      };
    }

    let profileId =
      lookupResult.userId;

    let accountCreated = false;

    if (!profileId) {
      const {
        data,
        error,
      } =
        await supabaseAdmin.auth.admin.createUser({
          email: normalizedEmail,
          email_confirm: false,
        });

      if (error || !data.user) {
        console.error(
          "Blog manager invite auth-user creation failed",
          {
            message: error?.message,
            status: error?.status,
          },
        );

        return {
          ok: false,
          code: "INTERNAL_ERROR",
          reason:
            "account_creation_failed",
          message:
            "The blog access could not be granted.",
        };
      }

      profileId = data.user.id;
      accountCreated = true;
    }

    const profileReady =
      await waitForProfile(
        profileId,
      );

    if (!profileReady) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        reason:
          "profile_not_ready",
        message:
          "The blog access could not be granted.",
      };
    }

    const grant =
      await upsertGrant({
        email: normalizedEmail,
        note,
        profileId,
        adminProfileId,
      });

    if (!grant) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        reason: "grant_write_failed",
        message:
          "The blog access could not be granted.",
      };
    }

    /*
     * The account and the grant are the durable outcome, and both
     * are already written. A send failure is reported as a flag,
     * not an error, so the admin sees that access WAS granted and
     * can offer a resend rather than pressing invite again in the
     * belief that nothing happened.
     */
    const emailSent =
      await sendInviteEmail({
        email: normalizedEmail,
      });

    return {
      ok: true,
      grant: {
        id: grant.id,
        email: grant.email,
        profile_id:
          grant.profile_id ??
          profileId,
        note: grant.note ?? null,
        granted_at:
          grant.granted_at,
        account_created:
          accountCreated,
        email_sent: emailSent,
      },
    };
  };
