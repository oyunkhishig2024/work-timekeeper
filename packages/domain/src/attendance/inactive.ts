import type { AttendanceStatus } from "../types";

/** PRD 6.8: a silent device counts as "location inactive" after this many minutes (tenant setting later). */
export const LOCATION_INACTIVE_TOLERANCE_MINUTES = 60;

export interface InactiveInput {
  status: AttendanceStatus;
  /** Start of the duty (PRD 6.1); null when nobody is expected. */
  expectedStart: Date | null;
  /** Last time the employee's active device was heard from (event or heartbeat); null = never. */
  lastSeenAt: Date | null;
  /** The employee has an active registered device; without one there is nothing to be "inactive" (manual attendance, PRD 15.4). */
  hasDevice: boolean;
  now: Date;
  toleranceMinutes?: number;
}

/**
 * PRD 6.5: "Байршил идэвхгүй" - an employee who should be at work, has no arrival yet, and whose phone has not reported for longer
 * than the tolerance (location switched off, permission revoked, app killed). It is an indicator for HR to follow up, never proof of
 * absence and never a status of its own: the day is still Хүлээгдэж байна / Ирээгүй until an arrival is recorded or a reason is given.
 * Only the current duty is considered (the first 24 hours from its start), so old days are not flagged.
 */
export function isLocationInactive(i: InactiveInput): boolean {
  if (!i.hasDevice || i.expectedStart === null) return false;
  if (i.status !== "PENDING" && i.status !== "NO_SHOW") return false;
  const sinceStart = i.now.getTime() - i.expectedStart.getTime();
  if (sinceStart < 0 || sinceStart > 24 * 3_600_000) return false;
  const tolerance = (i.toleranceMinutes ?? LOCATION_INACTIVE_TOLERANCE_MINUTES) * 60_000;
  // Silence is measured from the later of "last heard" and "duty start": nobody is inactive before the duty has begun.
  const since = Math.max(
    i.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    i.expectedStart.getTime(),
  );
  return i.now.getTime() - since > tolerance;
}
