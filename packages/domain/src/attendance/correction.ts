import { minutesBetween } from "../time";
import type { AttendanceStatus } from "../types";
import type { DerivedAttendance } from "./derive";

/** What HR may set by hand (PRD 6.9): Цагтаа / Хоцорсон / Ирээгүй. Excused days come from reasons, not corrections. */
export type CorrectionStatus = "ON_TIME" | "LATE" | "NO_SHOW";

export interface Correction {
  status: CorrectionStatus;
  /** Optional arrival time; not allowed with NO_SHOW. */
  arrivalAt: Date | null;
}

export interface CorrectedAttendance extends DerivedAttendance {
  source: "AUTO" | "CORRECTED";
}

/** Why a correction is not valid; null when it is. */
export function correctionProblem(c: Correction): string | null {
  if (c.status === "NO_SHOW" && c.arrivalAt !== null) return "NO_SHOW_WITH_ARRIVAL";
  return null;
}

/**
 * PRD 6.9: a correction is layered over the system-computed result and wins over it (HR has the last word, no second
 * approval). The system value is never overwritten, the caller keeps it next to the corrected one.
 *
 * - NO_SHOW: no arrival.
 * - ON_TIME: the given arrival, else the system one; never late minutes.
 * - LATE: the given arrival, else the system one; late minutes are counted from the start when an arrival is known.
 *
 * Only applies to a day where somebody is expected (`start` not null); otherwise the system value is returned.
 */
export function applyCorrection(
  system: DerivedAttendance,
  correction: Correction | null,
  start: Date | null,
): CorrectedAttendance {
  if (correction === null || start === null) return { ...system, source: "AUTO" };
  const status: AttendanceStatus = correction.status;
  if (correction.status === "NO_SHOW") {
    return { status, arrivalAt: null, lateMinutes: 0, source: "CORRECTED" };
  }
  const arrivalAt = correction.arrivalAt ?? system.arrivalAt;
  const lateMinutes =
    correction.status === "LATE" && arrivalAt !== null
      ? Math.max(0, minutesBetween(start, arrivalAt))
      : 0;
  return { status, arrivalAt, lateMinutes, source: "CORRECTED" };
}
