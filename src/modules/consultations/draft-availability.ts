import { removeBusySlots } from "../availability/availability.conflicts.js";
import { calculateLocalAvailability } from "../availability/availability.local.js";
import { getConsultantForAvailability } from "../availability/availability.service.js";
import { getGoogleBusyIntervals } from "../availability/google-freebusy.js";

type ValidateDraftSlotInput = {
  consultantId: string;
  startAt: string;
  /*
   * Supplied by the caller from
   * app_settings.consultation_duration_minutes, loaded once for
   * the request. Amendment 007 section 8.5.
   *
   * The same value drives both the end time returned here and the
   * slot generation used to re-validate the slot, so the two can
   * never disagree.
   */
  durationMinutes: number;
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
  durationMinutes,
}: ValidateDraftSlotInput): Promise<DraftSlotValidationResult> => {
  const slotDurationMilliseconds =
    durationMinutes * 60 * 1000;

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
      slotDurationMilliseconds,
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
      slotDurationMinutes:
        durationMinutes,
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
    console.warn(
      "Draft slot validated in degraded mode",
      {
        consultantId,
        code: googleResult.code,
        calendarConnected:
          googleResult.calendarConnected,
      },
    );

    return {
      ok: true,
      endAt: requestedEndIso,
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
