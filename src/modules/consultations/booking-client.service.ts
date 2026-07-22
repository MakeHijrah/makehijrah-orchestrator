import { supabaseAdmin } from "../../lib/supabase.js";

type ResolveBookingClientInput = {
  email: string;
  fullName: string;
  phoneWhatsapp: string | null;
};

export type ResolveBookingClientResult =
  | {
      ok: true;
      profileId: string;
      created: boolean;
    }
  | {
      ok: false;
      code: "INTERNAL_ERROR";
      message: string;
    };

const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

const findAuthUserByEmail = async (
  email: string,
): Promise<
  | {
      ok: true;
      userId: string | null;
    }
  | {
      ok: false;
      message: string;
    }
> => {
  const perPage = 200;
  let page = 1;

  while (true) {
    const {
      data,
      error,
    } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      console.error(
        "Booking user lookup failed",
        {
          message: error.message,
          status: error.status,
          email,
        },
      );

      return {
        ok: false,
        message:
          "The booking account could not be resolved.",
      };
    }

    const matchedUser = data.users.find(
      (user) =>
        user.email?.trim().toLowerCase() === email,
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

const updateClientProfile = async ({
  profileId,
  fullName,
  phoneWhatsapp,
}: {
  profileId: string;
  fullName: string;
  phoneWhatsapp: string | null;
}): Promise<boolean> => {
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      full_name: fullName,
      phone_whatsapp: phoneWhatsapp,
    })
    .eq("id", profileId)
    .eq("role", "client");

  if (error) {
    console.error(
      "Booking client profile update failed",
      {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        profileId,
      },
    );

    return false;
  }

  return true;
};

export const resolveBookingClient = async ({
  email,
  fullName,
  phoneWhatsapp,
}: ResolveBookingClientInput): Promise<ResolveBookingClientResult> => {
  const normalizedEmail = normalizeEmail(email);

  const lookupResult =
    await findAuthUserByEmail(normalizedEmail);

  if (!lookupResult.ok) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: lookupResult.message,
    };
  }

  let profileId = lookupResult.userId;
  let created = false;

  if (!profileId) {
    const {
      data,
      error,
    } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      email_confirm: false,
      user_metadata: {
        full_name: fullName,
      },
    });

    if (error || !data.user) {
      console.error(
        "Booking client creation failed",
        {
          message: error?.message,
          status: error?.status,
          email: normalizedEmail,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The booking account could not be created.",
      };
    }

    profileId = data.user.id;
    created = true;
  }

  const { data: profile, error: profileError } =
    await supabaseAdmin
      .from("profiles")
      .select("id, role")
      .eq("id", profileId)
      .maybeSingle();

  if (profileError || !profile) {
    console.error(
      "Booking client profile lookup failed",
      {
        code: profileError?.code,
        message: profileError?.message,
        details: profileError?.details,
        hint: profileError?.hint,
        profileId,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The booking profile could not be resolved.",
    };
  }

  if (profile.role !== "client") {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "This email cannot be used for a client booking.",
    };
  }

  const profileUpdated = await updateClientProfile({
    profileId,
    fullName,
    phoneWhatsapp,
  });

  if (!profileUpdated) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The booking profile could not be updated.",
    };
  }

  return {
    ok: true,
    profileId,
    created,
  };
};
