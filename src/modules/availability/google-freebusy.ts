import { getGoogleAccessToken } from "../oauth/google-access-token.js";
import type { BusyInterval } from "./availability.conflicts.js";

const GOOGLE_FREEBUSY_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/freeBusy";

type GoogleFreeBusyPeriod = {
  start?: string;
  end?: string;
};

type GoogleCalendarFreeBusy = {
  busy?: GoogleFreeBusyPeriod[];
  errors?: Array<{
    domain?: string;
    reason?: string;
  }>;
};

type GoogleFreeBusyResponse = {
  calendars?: Record<string, GoogleCalendarFreeBusy>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export type GoogleFreeBusyResult =
  | {
      ok: true;
      intervals: BusyInterval[];
    }
  | {
      ok: false;
      code:
        | "OAUTH_NOT_CONNECTED"
        | "OAUTH_REVOKED"
        | "GOOGLE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const isValidBusyPeriod = (
  period: GoogleFreeBusyPeriod,
): period is {
  start: string;
  end: string;
} => {
  if (!period.start || !period.end) {
    return false;
  }

  const start = Date.parse(period.start);
  const end = Date.parse(period.end);

  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start
  );
};

export const getGoogleBusyIntervals = async (
  consultantId: string,
  from: string,
  to: string,
): Promise<GoogleFreeBusyResult> => {
  const accessTokenResult =
    await getGoogleAccessToken(consultantId);

  if (!accessTokenResult.ok) {
    return {
      ok: false,
      code: accessTokenResult.code,
      message: accessTokenResult.message,
    };
  }

  try {
    const response = await fetch(
      GOOGLE_FREEBUSY_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${accessTokenResult.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          timeZone: "UTC",
          items: [
            {
              id: "primary",
            },
          ],
        }),
      },
    );

    const data =
      (await response.json()) as GoogleFreeBusyResponse;

    if (!response.ok) {
      console.error("Google FreeBusy request failed:", {
        status: response.status,
        code: data.error?.code,
        message: data.error?.message,
        googleStatus: data.error?.status,
      });

      return {
        ok: false,
        code: "GOOGLE_ERROR",
        message:
          "Google Calendar availability could not be checked.",
      };
    }

    const primaryCalendar =
      data.calendars?.primary;

    if (!primaryCalendar) {
      console.error(
        "Google FreeBusy response did not include the primary calendar.",
      );

      return {
        ok: false,
        code: "GOOGLE_ERROR",
        message:
          "Google Calendar availability could not be checked.",
      };
    }

    if (
      primaryCalendar.errors &&
      primaryCalendar.errors.length > 0
    ) {
      console.error(
        "Google FreeBusy calendar returned errors:",
        primaryCalendar.errors,
      );

      return {
        ok: false,
        code: "GOOGLE_ERROR",
        message:
          "Google Calendar availability could not be checked.",
      };
    }

    const intervals: BusyInterval[] = (
      primaryCalendar.busy ?? []
    )
      .filter(isValidBusyPeriod)
      .map((period) => ({
        start_at: period.start,
        end_at: period.end,
      }));

    return {
      ok: true,
      intervals,
    };
  } catch (error) {
    console.error(
      "Google FreeBusy request failed:",
      error instanceof Error ? error.message : error,
    );

    return {
      ok: false,
      code: "GOOGLE_ERROR",
      message:
        "Google Calendar availability could not be checked.",
    };
  }
};
