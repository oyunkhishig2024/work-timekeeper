import { classifyArrival, findConfirmedArrival } from "../arrival";
import { isPastCutoff } from "../noshow";
import type { Expectation } from "../schedule/types";
import type { AttendanceStatus, GeofenceEvent } from "../types";

export interface DeriveInput {
  expectation: Expectation;
  /** Server-time-corrected geofence events of the expected location for this duty (PRD 6.8). */
  events: readonly GeofenceEvent[];
  /** An approved reason covers this work date (PRD 6.6, 17). */
  hasReason: boolean;
  now: Date;
}

export interface DerivedAttendance {
  status: AttendanceStatus;
  /** First ENTER of the confirmed stay (PRD 6.4); null when none. */
  arrivalAt: Date | null;
  /** Arrival minus start, never reduced by grace (PRD 6.2). 0 unless LATE. */
  lateMinutes: number;
}

const none = (status: AttendanceStatus): DerivedAttendance => ({
  status,
  arrivalAt: null,
  lateMinutes: 0,
});

/**
 * PRD 6.6 precedence for one employee and one work date:
 * not expected / not configured → reason → confirmed arrival → past cut-off (NO_SHOW) → PENDING.
 *
 * Pure: the caller supplies the expectation (`getExpectation`), the events and the clock. Events before
 * `earlyWindowStart` are ignored (PRD 23.2). A late arrival after the cut-off is still LATE (PRD 6.3).
 */
export function deriveStatus(input: DeriveInput): DerivedAttendance {
  const { expectation, hasReason, now } = input;

  if (!expectation.expected) {
    if (expectation.reason === "NOT_CONFIGURED") return none("NOT_CONFIGURED");
    return none("NOT_EXPECTED");
  }

  const events = input.events.filter(
    (e) => e.at.getTime() >= expectation.earlyWindowStart.getTime(),
  );
  const arrivalAt = findConfirmedArrival(events, expectation.minStayMinutes, now);

  if (hasReason) return { status: "EXCUSED", arrivalAt, lateMinutes: 0 };

  if (arrivalAt !== null) {
    const { status, lateMinutes } = classifyArrival(
      expectation.start,
      expectation.graceMinutes,
      arrivalAt,
    );
    return { status, arrivalAt, lateMinutes };
  }

  if (isPastCutoff(now, expectation.cutoff)) return none("NO_SHOW");
  return none("PENDING");
}

/**
 * PRD 6.1: on a day nobody is expected (holiday, off day) a confirmed stay is shown as WORKED_OFF_DAY.
 * Inactive and unconfigured employees never produce it.
 */
export function deriveOffDayStatus(
  expectation: Expectation,
  events: readonly GeofenceEvent[],
  minStayMinutes: number,
  now: Date,
): DerivedAttendance {
  if (
    !expectation.expected &&
    (expectation.reason === "HOLIDAY" || expectation.reason === "OFF_DAY")
  ) {
    const arrivalAt = findConfirmedArrival(events, minStayMinutes, now);
    if (arrivalAt) return { status: "WORKED_OFF_DAY", arrivalAt, lateMinutes: 0 };
  }
  return deriveStatus({ expectation, events, hasReason: false, now });
}
