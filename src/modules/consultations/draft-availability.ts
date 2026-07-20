import { removeBusySlots } from "../availability/availability.conflicts.js";
import { calculateLocalAvailability } from "../availability/availability.local.js";
import { getConsultantForAvailability } from "../availability/availability.service.js";
import { getGoogleBusyIntervals } from "../availability/google-freebusy.js";

type ValidateDraftSlotInput = {
  consultantId: string;
  startAt: string;
};

export type DraftSlotValidationResult =
  | {
      ok: true;
      endAt: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "OAUTH_NOT_CONNECTED"
        | "SLOT_TAKEN"
        | "SLOT_TOO_SOON"
        | "SLOT_OUTSIDE_HOURS"
        | "GOOGLE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const SLOT_DURATION_MILLISECONDS =
  60 * 60 * 1000;

const VALIDATION_WINDOW_PADDING_MILLISECONDS =
  24 * 60 * 60 * 1000;

const timestampsMatch = (
  first: string,
  second: string,
): boolean => {
  const firstTimestamp = Date.parse(first);
  const secondTimestamp = Date.parse(second);

  return (
    Number.isFinite(firstTimestamp) &&
    Number.isFinite(secondTimestamp) &&
    firstTimestamp === secondTimestamp
  );
};

export const validateDraftSlot = async ({
  consultantId,
  startAt,
}: ValidateDraftSlotInput): Promise<DraftSlotValidationResult> => {
  const requestedStart = new Date(startAt);

  if (Number.isNaN(requestedStart.getTime())) {
    return {
      ok: false,
      code: "SLOT_OUTSIDE_HOURS",
      message:
        "The selected consultation time is invalid.",
    };
  }

  const requestedEnd = new Date(
    requestedStart.getTime() +
      SLOT_DURATION_MILLISECONDS,
  );

  const requestedStartIso =
    requestedStart.toISOString();

  const requestedEndIso =
    requestedEnd.toISOString();

  const validationFrom = new Date(
    requestedStart.getTime() -
      VALIDATION_WINDOW_PADDING_MILLISECONDS,
  ).toISOString();

  const validationTo = new Date(
    requestedEnd.getTime() +
      VALIDATION_WINDOW_PADDING_MILLISECONDS,
  ).toISOString();

  const consultantResult =
    await getConsultantForAvailability(
      consultantId,
    );

  if (!consultantResult.ok) {
    if (consultantResult.code === "NOT_FOUND") {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: consultantResult.message,
      };
    }

    if (
      consultantResult.code ===
      "OAUTH_NOT_CONNECTED"
    ) {
      return {
        ok: false,
        code: "OAUTH_NOT_CONNECTED",
        message: consultantResult.message,
      };
    }

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: consultantResult.message,
    };
  }

  const localResult =
    await calculateLocalAvailability({
      consultantId,
      timezone:
        consultantResult.consultant.timezone,
      workingHours:
        consultantResult.consultant.workingHours,
      minimumBookingNoticeHours:
        consultantResult.consultant
          .minimumBookingNoticeHours,
      from: validationFrom,
      to: validationTo,
    });

  if (!localResult.ok) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: localResult.message,
    };
  }

  const locallyAvailable =
    localResult.data.slots.some(
      (slot) =>
        timestampsMatch(
          slot.start_at,
          requestedStartIso,
        ) &&
        timestampsMatch(
          slot.end_at,
          requestedEndIso,
        ),
    );

  if (!locallyAvailable) {
    const minimumAllowedStart =
      Date.now() +
      consultantResult.consultant
        .minimumBookingNoticeHours *
        60 *
        60 *
        1000;

    if (
      requestedStart.getTime() <
      minimumAllowedStart
    ) {
      return {
        ok: false,
        code: "SLOT_TOO_SOON",
        message:
          "The selected consultation time is too soon.",
      };
    }

    return {
      ok: false,
      code: "SLOT_OUTSIDE_HOURS",
      message:
        "The selected consultation time is outside the consultant's availability.",
    };
  }

  const googleResult =
    await getGoogleBusyIntervals(
      consultantId,
      validationFrom,
      validationTo,
    );

  if (!googleResult.ok) {
    if (
      googleResult.code ===
        "OAUTH_NOT_CONNECTED" ||
      googleResult.code === "OAUTH_REVOKED"
    ) {
      return {
        ok: false,
        code: "OAUTH_NOT_CONNECTED",
        message:
          "The consultant's Google Calendar is not connected.",
      };
    }

    if (
      googleResult.code === "GOOGLE_ERROR"
    ) {
      return {
        ok: false,
        code: "GOOGLE_ERROR",
        message: googleResult.message,
      };
    }

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: googleResult.message,
    };
  }

  const remainingSlots = removeBusySlots(
    [
      {
        start_at: requestedStartIso,
        end_at: requestedEndIso,
      },
    ],
    googleResult.intervals,
  );

  if (remainingSlots.length === 0) {
    return {
      ok: false,
      code: "SLOT_TAKEN",
      message:
        "The selected consultation time is no longer available.",
    };
  }

  return {
    ok: true,
    endAt: requestedEndIso,
  };
};
