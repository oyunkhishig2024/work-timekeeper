import type { GeofenceEvent } from "./types";
import { addMinutes, minutesBetween, truncateToMinute } from "./time";

export interface ArrivalClassification {
  status: "ON_TIME" | "LATE";
  /** Arrival minus start time, never reduced by grace (PRD 6.2). 0 when on time or early. */
  lateMinutes: number;
}

/**
 * PRD 6.2: with start 08:00 and grace 15, 08:00–08:15:59 is on time and 08:16:00+ is late.
 * The arrival is truncated to the minute before comparing.
 */
export function classifyArrival(
  start: Date,
  graceMinutes: number,
  arrival: Date,
): ArrivalClassification {
  const arrivalMinute = truncateToMinute(arrival);
  const lastOnTimeMinute = addMinutes(truncateToMinute(start), graceMinutes);
  if (arrivalMinute.getTime() <= lastOnTimeMinute.getTime()) {
    return { status: "ON_TIME", lateMinutes: 0 };
  }
  return { status: "LATE", lateMinutes: Math.max(0, minutesBetween(start, arrival)) };
}

/**
 * PRD 6.4 (minimum geofence stay). Returns the arrival time — the timestamp of the first ENTER of
 * the first stay that lasted at least `minStayMinutes` — or null when no stay is confirmed yet.
 *
 * - A stay shorter than the minimum is discarded; a later ENTER starts a new stay.
 * - Once a stay is confirmed, later exits/re-entries do not change the arrival.
 * - A stay still in progress is confirmed when `now` is at least `minStayMinutes` after its ENTER.
 */
export function findConfirmedArrival(
  events: readonly GeofenceEvent[],
  minStayMinutes: number,
  now: Date,
): Date | null {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const minStayMs = minStayMinutes * 60_000;
  let enteredAt: Date | null = null;

  for (const event of sorted) {
    if (event.type === "ENTER") {
      if (enteredAt === null) enteredAt = event.at;
    } else if (enteredAt !== null) {
      if (event.at.getTime() - enteredAt.getTime() >= minStayMs) return enteredAt;
      enteredAt = null;
    }
  }

  if (enteredAt !== null && now.getTime() - enteredAt.getTime() >= minStayMs) return enteredAt;
  return null;
}
