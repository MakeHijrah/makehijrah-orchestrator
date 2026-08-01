import {
  isStripeModeConfigured,
  type StripeMode,
} from "../../lib/stripe.js";
import {
  getSettings,
  updateSettings,
  SettingsUnavailableError,
  type AppSettings,
} from "./settings.provider.js";
import type {
  UpdateSettingsInput,
  UpdateStripeModeInput,
} from "./settings.schema.js";

/*
 * Settings read and write service. PROJECT_LOCK Amendment 007.
 *
 * Every projection is built explicitly. Nothing spreads the raw
 * settings row into a response, so a column added later cannot
 * leak into a public payload by accident.
 */

export type PublicSettingsView = {
  consultation_price_cents: number;
  consultation_currency: string;
  consultation_duration_minutes: number;
};

export type AdminSettingsView = {
  consultation_price_cents: number;
  consultation_currency: string;
  consultation_duration_minutes: number;
  support_email: string | null;
  default_timezone: string;
  stripe_mode: StripeMode;
  stripe_test_configured: boolean;
  stripe_live_configured: boolean;
  updated_at: string;
};

export type StripeModeView = {
  stripe_mode: StripeMode;
  stripe_test_configured: boolean;
  stripe_live_configured: boolean;
};

export type SettingsResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      code:
        | "STRIPE_MODE_NOT_CONFIGURED"
        | "LIVE_MODE_CONFIRMATION_REQUIRED"
        | "INTERNAL_ERROR";
      message: string;
    };

/*
 * Exactly three fields. No stripe_mode, no configured booleans, no
 * support_email, no default_timezone, no timestamps, no audit id.
 * Amendment 007 section 4.6.
 */
const toPublicView = (
  settings: AppSettings,
): PublicSettingsView => ({
  consultation_price_cents:
    settings.consultation_price_cents,
  consultation_currency:
    settings.consultation_currency,
  consultation_duration_minutes:
    settings.consultation_duration_minutes,
});

const toAdminView = (
  settings: AppSettings,
): AdminSettingsView => ({
  consultation_price_cents:
    settings.consultation_price_cents,
  consultation_currency:
    settings.consultation_currency,
  consultation_duration_minutes:
    settings.consultation_duration_minutes,
  support_email:
    settings.support_email,
  default_timezone:
    settings.default_timezone,
  stripe_mode:
    settings.stripe_mode,
  stripe_test_configured:
    isStripeModeConfigured("test"),
  stripe_live_configured:
    isStripeModeConfigured("live"),
  updated_at: settings.updated_at,
});

const toStripeModeView = (
  settings: AppSettings,
): StripeModeView => ({
  stripe_mode:
    settings.stripe_mode,
  stripe_test_configured:
    isStripeModeConfigured("test"),
  stripe_live_configured:
    isStripeModeConfigured("live"),
});

const internalError = <T>(
  message: string,
): SettingsResult<T> => ({
  ok: false,
  code: "INTERNAL_ERROR",
  message,
});

export const readPublicSettings =
  async (): Promise<
    SettingsResult<PublicSettingsView>
  > => {
    try {
      return {
        ok: true,
        data: toPublicView(
          await getSettings(),
        ),
      };
    } catch (error) {
      if (
        !(
          error instanceof
          SettingsUnavailableError
        )
      ) {
        throw error;
      }

      return internalError(
        "The settings could not be loaded.",
      );
    }
  };

export const readAdminSettings =
  async (): Promise<
    SettingsResult<AdminSettingsView>
  > => {
    try {
      return {
        ok: true,
        data: toAdminView(
          await getSettings(),
        ),
      };
    } catch (error) {
      if (
        !(
          error instanceof
          SettingsUnavailableError
        )
      ) {
        throw error;
      }

      return internalError(
        "The settings could not be loaded.",
      );
    }
  };

export const applySettingsUpdate =
  async ({
    input,
    adminProfileId,
  }: {
    input: UpdateSettingsInput;
    adminProfileId: string;
  }): Promise<
    SettingsResult<AdminSettingsView>
  > => {
    try {
      const updated =
        await updateSettings({
          patch: input,
          adminProfileId,
        });

      return {
        ok: true,
        data: toAdminView(updated),
      };
    } catch (error) {
      if (
        !(
          error instanceof
          SettingsUnavailableError
        )
      ) {
        throw error;
      }

      return internalError(
        "The settings could not be updated.",
      );
    }
  };

export const applyStripeModeUpdate =
  async ({
    input,
    adminProfileId,
  }: {
    input: UpdateStripeModeInput;
    adminProfileId: string;
  }): Promise<
    SettingsResult<StripeModeView>
  > => {
    const targetMode =
      input.stripe_mode;

    /*
     * The target mode's credentials must exist in Railway before
     * the switch is recorded, or every subsequent payment would
     * fail. Amendment 007 section 5.5.
     */
    if (
      !isStripeModeConfigured(
        targetMode,
      )
    ) {
      return {
        ok: false,
        code: "STRIPE_MODE_NOT_CONFIGURED",
        message:
          "The requested Stripe mode is not configured on the server.",
      };
    }

    if (
      targetMode === "live" &&
      input.confirm_live !== true
    ) {
      return {
        ok: false,
        code: "LIVE_MODE_CONFIRMATION_REQUIRED",
        message:
          "Switching to live mode requires explicit confirmation.",
      };
    }

    try {
      const updated =
        await updateSettings({
          patch: {
            stripe_mode: targetMode,
          },
          adminProfileId,
        });

      return {
        ok: true,
        data:
          toStripeModeView(updated),
      };
    } catch (error) {
      if (
        !(
          error instanceof
          SettingsUnavailableError
        )
      ) {
        throw error;
      }

      return internalError(
        "The Stripe mode could not be updated.",
      );
    }
  };
