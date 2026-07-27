import { randomUUID } from "node:crypto";
import { getGoogleAccessToken } from "../oauth/google-access-token.js";

const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const CONFERENCE_POLL_ATTEMPTS = 5;
const CONFERENCE_POLL_DELAY_MILLISECONDS = 1_000;

type GoogleConferenceEntryPoint = {
  entryPointType?: string;
  uri?: string;
};

type GoogleConferenceCreateRequest = {
  status?: {
    statusCode?: string;
  };
};

type GoogleConferenceData = {
  entryPoints?: GoogleConferenceEntryPoint[];
  createRequest?: GoogleConferenceCreateRequest;
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

const sleep = async (
  milliseconds: number,
): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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

const loadCalendarEvent = async ({
  accessToken,
  googleEventId,
}: {
  accessToken: string;
  googleEventId: string;
}): Promise<GoogleCalendarEventResponse | null> => {
  const endpoint = new URL(
    `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(
      googleEventId,
    )}`,
  );

  endpoint.searchParams.set(
    "conferenceDataVersion",
    "1",
  );

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
      },
    });

    const data =
      (await response.json()) as GoogleCalendarEventResponse;

    if (!response.ok) {
      console.error(
        "Google Calendar event lookup failed",
        {
          googleEventId,
          status: response.status,
          code: data.error?.code,
          message: data.error?.message,
          googleStatus:
            data.error?.status,
        },
      );

      return null;
    }

    return data;
  } catch (error) {
    console.error(
      "Google Calendar event lookup failed",
      {
        googleEventId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Google Calendar error",
      },
    );

    return null;
  }
};

const waitForMeetLink = async ({
  accessToken,
  googleEventId,
}: {
  accessToken: string;
  googleEventId: string;
}): Promise<string | null> => {
  for (
    let attempt = 0;
    attempt < CONFERENCE_POLL_ATTEMPTS;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(
        CONFERENCE_POLL_DELAY_MILLISECONDS,
      );
    }

    const event =
      await loadCalendarEvent({
        accessToken,
        googleEventId,
      });

    if (!event) {
      continue;
    }

    const meetLink =
      readMeetLink(event);

    if (meetLink) {
      return meetLink;
    }

    const status =
      event.conferenceData
        ?.createRequest?.status
        ?.statusCode;

    if (status === "failure") {
      return null;
    }
  }

  return null;
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

      if (!googleEventId) {
        console.error(
          "Google Calendar event response had no event ID",
          {
            consultationId,
            consultantId,
          },
        );

        return {
          ok: false,
          code: "GOOGLE_ERROR",
          message:
            "The Google Calendar event did not return an event ID.",
        };
      }

      const immediateMeetLink =
        readMeetLink(data);

      const meetLink =
        immediateMeetLink ??
        (await waitForMeetLink({
          accessToken:
            accessTokenResult.accessToken,
          googleEventId,
        }));

      if (!meetLink) {
        console.error(
          "Google Calendar event did not produce a Meet link",
          {
            consultationId,
            consultantId,
            googleEventId,
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

export type DeleteConsultationCalendarEventResult =
  | {
      ok: true;
      alreadyDeleted: boolean;
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

export const deleteConsultationCalendarEvent =
  async ({
    consultantId,
    googleEventId,
  }: {
    consultantId: string;
    googleEventId: string;
  }): Promise<DeleteConsultationCalendarEventResult> => {
    const accessTokenResult =
      await getGoogleAccessToken(
        consultantId,
      );

    if (!accessTokenResult.ok) {
      return accessTokenResult;
    }

    const endpoint = new URL(
      `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(
        googleEventId,
      )}`,
    );

    endpoint.searchParams.set(
      "sendUpdates",
      "none",
    );

    try {
      const response = await fetch(
        endpoint,
        {
          method: "DELETE",
          headers: {
            Authorization:
              `Bearer ${accessTokenResult.accessToken}`,
          },
        },
      );

      if (response.status === 404 ||
          response.status === 410) {
        return {
          ok: true,
          alreadyDeleted: true,
        };
      }

      if (!response.ok) {
        let message =
          "Unknown Google Calendar error";

        try {
          const data = await response.json() as {
            error?: {
              message?: string;
            };
          };

          message =
            data.error?.message ??
            message;
        } catch {
          // Ignore malformed Google response bodies.
        }

        console.error(
          "Google Calendar event deletion failed",
          {
            consultantId,
            googleEventId,
            status: response.status,
            message,
          },
        );

        return {
          ok: false,
          code: "GOOGLE_ERROR",
          message:
            "The Google Calendar event could not be removed.",
        };
      }

      return {
        ok: true,
        alreadyDeleted: false,
      };
    } catch (error) {
      console.error(
        "Google Calendar event deletion failed",
        {
          consultantId,
          googleEventId,
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
          "The Google Calendar event could not be removed.",
      };
    }
  };
