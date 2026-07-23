import { randomUUID } from "node:crypto";
import { getGoogleAccessToken } from "../oauth/google-access-token.js";

const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type GoogleConferenceEntryPoint = {
  entryPointType?: string;
  uri?: string;
};

type GoogleConferenceData = {
  entryPoints?: GoogleConferenceEntryPoint[];
};

type GoogleCalendarEventResponse = {
  id?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: GoogleConferenceData;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export type CreateConsultationCalendarEventResult =
  | {
      ok: true;
      googleEventId: string;
      meetLink: string;
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

type CreateConsultationCalendarEventInput = {
  consultationId: string;
  consultantId: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  clientTimezone: string;
};

const readMeetLink = (
  event: GoogleCalendarEventResponse,
): string | null => {
  const directLink =
    event.hangoutLink?.trim();

  if (directLink) {
    return directLink;
  }

  const videoEntryPoint =
    event.conferenceData?.entryPoints?.find(
      (entryPoint) =>
        entryPoint.entryPointType ===
          "video" &&
        typeof entryPoint.uri ===
          "string" &&
        entryPoint.uri.trim().length > 0,
    );

  return videoEntryPoint?.uri?.trim() || null;
};

export const createConsultationCalendarEvent =
  async ({
    consultationId,
    consultantId,
    scheduledStartAt,
    scheduledEndAt,
    clientTimezone,
  }: CreateConsultationCalendarEventInput): Promise<CreateConsultationCalendarEventResult> => {
    const startMilliseconds =
      Date.parse(scheduledStartAt);

    const endMilliseconds =
      Date.parse(scheduledEndAt);

    if (
      !Number.isFinite(startMilliseconds) ||
      !Number.isFinite(endMilliseconds) ||
      endMilliseconds <= startMilliseconds
    ) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The consultation schedule is invalid.",
      };
    }

    const accessTokenResult =
      await getGoogleAccessToken(
        consultantId,
      );

    if (!accessTokenResult.ok) {
      return accessTokenResult;
    }

    const endpoint = new URL(
      GOOGLE_CALENDAR_EVENTS_ENDPOINT,
    );

    endpoint.searchParams.set(
      "conferenceDataVersion",
      "1",
    );

    endpoint.searchParams.set(
      "sendUpdates",
      "none",
    );

    try {
      const response = await fetch(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${accessTokenResult.accessToken}`,
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            summary:
              "MakeHijrah Consultation",

            description:
              "MakeHijrah relocation consultation. Client contact details are managed inside the MakeHijrah consultation system.",

            start: {
              dateTime:
                new Date(
                  startMilliseconds,
                ).toISOString(),
              timeZone: "UTC",
            },

            end: {
              dateTime:
                new Date(
                  endMilliseconds,
                ).toISOString(),
              timeZone: "UTC",
            },

            extendedProperties: {
              private: {
                consultation_id:
                  consultationId,
                client_timezone:
                  clientTimezone,
              },
            },

            conferenceData: {
              createRequest: {
                requestId:
                  `consultation-${consultationId}-${randomUUID()}`,
                conferenceSolutionKey: {
                  type: "hangoutsMeet",
                },
              },
            },

            attendees: [],
          }),
        },
      );

      const data =
        (await response.json()) as GoogleCalendarEventResponse;

      if (!response.ok) {
        console.error(
          "Google Calendar event creation failed",
          {
            consultationId,
            consultantId,
            status: response.status,
            code: data.error?.code,
            message:
              data.error?.message,
            googleStatus:
              data.error?.status,
          },
        );

        return {
          ok: false,
          code: "GOOGLE_ERROR",
          message:
            "The Google Calendar event could not be created.",
        };
      }

      const googleEventId =
        data.id?.trim();

      const meetLink =
        readMeetLink(data);

      if (
        !googleEventId ||
        !meetLink
      ) {
        console.error(
          "Google Calendar event response was incomplete",
          {
            consultationId,
            consultantId,
            hasEventId:
              Boolean(googleEventId),
            hasMeetLink:
              Boolean(meetLink),
          },
        );

        return {
          ok: false,
          code: "GOOGLE_ERROR",
          message:
            "The Google Calendar event did not return a Meet link.",
        };
      }

      return {
        ok: true,
        googleEventId,
        meetLink,
      };
    } catch (error) {
      console.error(
        "Google Calendar event creation failed",
        {
          consultationId,
          consultantId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Google Calendar error",
        },
      );

      return {
        ok: false,
        code: "GOOGLE_ERROR",
        message:
          "The Google Calendar event could not be created.",
      };
    }
  };
