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

/**
 * Events up to this long after the end of the duty still belong to it: a person may work late into the night (a duty that
 * ends at 17:30 and a last exit at 01:40 is 8 h 10 min of overtime). Beyond it the events belong to the next day.
 */
const AFTER_END_MS = 12 * 3_600_000;
/**
 * After the end of the duty, an ENTER that comes this long after an EXIT is a new visit (the next morning), not the person
 * coming back, so the departure stays at that EXIT. Before the end any return counts, and a shorter walk out and back never
 * ends the day.
 */
const NEW_VISIT_GAP_MS = 3 * 3_600_000;
/** After the end of the duty a person still inside counts as INSIDE while the phone was heard from within this long. */
const HEARD_WITHIN_MS = 3_600_000;

/**
 * PRD 6.4, 23.2 (v1.25, v1.29): the departure shown next to the arrival. It is the last EXIT of the expected place after the
 * confirmed arrival, so a short walk out and back (lunch) changes nothing: the later ENTER makes the person INSIDE again.
 * Work after the end of the duty counts (overtime): the window is 12 h after the end, and an ENTER more than 3 h after an
 * EXIT is the next visit, not a return. A person still inside is INSIDE while the phone is heard from (`lastSeenAt`, the
 * last time the phone reported anything) and UNKNOWN once the duty is over and the phone has been silent for an hour.
 * Pure: it only reads the arrival and the events the caller counted for this duty.
 */
export function deriveDeparture(input: {
  expectation: Expectation;
  events: readonly GeofenceEvent[];
  arrivalAt: Date | null;
  now: Date;
  /** When the phone last reported anything; unknown (null / absent) is treated as silent. */
  lastSeenAt?: Date | null;
}): Departure {
  const { expectation, arrivalAt, now } = input;
  if (!expectation.expected || arrivalAt === null) return { state: null, departureAt: null };

  const end = expectation.end.getTime();
  const limit = end + AFTER_END_MS;
  const visit = visitAfter(input.events, arrivalAt, limit, (e) => e.at.getTime() >= end);
  const last = visit[visit.length - 1];

  if (last?.type === "EXIT") return { state: "LEFT", departureAt: last.at };
  // Still inside as far as the phone says (the arrival may also come from HR's correction and have no ENTER of its own).
  const heard =
    input.lastSeenAt != null && now.getTime() - input.lastSeenAt.getTime() <= HEARD_WITHIN_MS;
  const silentAfterEnd = now.getTime() >= end + HEARD_WITHIN_MS && !heard;
  return {
    state: now.getTime() >= limit || silentAfterEnd ? "UNKNOWN" : "INSIDE",
    departureAt: null,
  };
}

/**
 * The events of one visit: from the arrival, in time order, up to `limit`, stopping at the first ENTER that comes more
 * than the gap after an EXIT where `lateEnough(enter)` holds (that ENTER is the next visit, not a return).
 */
function visitAfter(
  events: readonly GeofenceEvent[],
  arrivalAt: Date,
  limit: number,
  lateEnough: (enter: GeofenceEvent) => boolean,
): GeofenceEvent[] {
  const sorted = events
    .filter((e) => e.at.getTime() >= arrivalAt.getTime() && e.at.getTime() < limit)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const visit: GeofenceEvent[] = [];
  for (const e of sorted) {
    const before = visit[visit.length - 1];
    if (
      before?.type === "EXIT" &&
      e.type === "ENTER" &&
      lateEnough(e) &&
      e.at.getTime() - before.at.getTime() > NEW_VISIT_GAP_MS
    ) {
      break;
    }
    visit.push(e);
  }
  return visit;
}

/**
 * PRD 6.1, 23.2 (v1.30): the departure on a day nobody is expected (a holiday or a day off) when the employee came anyway
 * (WORKED_OFF_DAY). There is no end of a duty, so the visit is the stay from the arrival: the last EXIT before a gap of more
 * than 3 h, within 24 h of the arrival. INSIDE while the phone is heard from, UNKNOWN when it is silent for an hour.
 * Nothing is derived from it (no overtime, no leaving early): HR decides what the day means.
 */
export function deriveOffDayDeparture(input: {
  events: readonly GeofenceEvent[];
  arrivalAt: Date | null;
  now: Date;
  lastSeenAt?: Date | null;
}): Departure {
  const { arrivalAt, now } = input;
  if (arrivalAt === null) return { state: null, departureAt: null };
  const visit = visitAfter(
    input.events,
    arrivalAt,
    arrivalAt.getTime() + 24 * 3_600_000,
    () => true,
  );
  const last = visit[visit.length - 1];
  if (last?.type === "EXIT") return { state: "LEFT", departureAt: last.at };
  const heard =
    input.lastSeenAt != null && now.getTime() - input.lastSeenAt.getTime() <= HEARD_WITHIN_MS;
  return { state: heard ? "INSIDE" : "UNKNOWN", departureAt: null };
}
