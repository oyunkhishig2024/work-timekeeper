import type { Expectation } from "../schedule/types";
import type { GeofenceEvent } from "../types";

/**
 * LEFT: the last thing the phone reported after the arrival was leaving the place. INSIDE: it is still there (the duty
 * is not over yet). UNKNOWN: the duty ended more than an hour ago and the phone never reported leaving, so the
 * departure cannot be told (battery, location off) and nothing is guessed.
 */
export type DepartureState = "LEFT" | "INSIDE" | "UNKNOWN";

export interface Departure {
  state: DepartureState | null;
  /** The last EXIT when `state` is LEFT. */
  departureAt: Date | null;
}

/** Events up to this long after the end of the duty still belong to it (a person who leaves a little after the end). */
const AFTER_END_MS = 4 * 3_600_000;
/** How long after the end of the duty a phone that never reported leaving counts as UNKNOWN. */
const UNKNOWN_AFTER_END_MS = 3_600_000;

/**
 * PRD 6.4, 23.2 (v1.25): the departure shown next to the arrival. It is the last EXIT of the expected place after the
 * confirmed arrival, so a short walk out and back (lunch) changes nothing: the later ENTER makes the person INSIDE again.
 * Pure: it only reads the arrival and the events the caller counted for this duty.
 */
export function deriveDeparture(input: {
  expectation: Expectation;
  events: readonly GeofenceEvent[];
  arrivalAt: Date | null;
  now: Date;
}): Departure {
  const { expectation, arrivalAt, now } = input;
  if (!expectation.expected || arrivalAt === null) return { state: null, departureAt: null };

  const limit = expectation.end.getTime() + AFTER_END_MS;
  const after = input.events
    .filter((e) => e.at.getTime() >= arrivalAt.getTime() && e.at.getTime() < limit)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = after[after.length - 1];

  if (last?.type === "EXIT") return { state: "LEFT", departureAt: last.at };
  // The arrival may come from HR's correction and have no ENTER of its own: still inside, as far as the phone says.
  const overdue = now.getTime() >= expectation.end.getTime() + UNKNOWN_AFTER_END_MS;
  return { state: overdue ? "UNKNOWN" : "INSIDE", departureAt: null };
}
