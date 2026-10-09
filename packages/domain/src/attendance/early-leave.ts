import type { Expectation } from "../schedule/types";
import type { Departure } from "./departure";

/**
 * PRD 23.2 (v1.27): minutes an employee left before the end of their duty, or 0 when they did not leave early.
 *
 * Early means: the last thing the phone reported was leaving (`LEFT`, so a walk out and back changes nothing) and that was
 * more than the tolerance before the end of the duty. A phone that never reported leaving (`UNKNOWN`) or is still inside is
 * never counted: nothing is guessed. Pure: the caller decides whether the day is one that can be early (an arrival that
 * counts, no reason covering it).
 */
export function earlyLeaveMinutes(input: {
  expectation: Expectation;
  departure: Departure;
}): number {
  const { expectation, departure } = input;
  if (!expectation.expected || departure.state !== "LEFT" || departure.departureAt === null)
    return 0;
  const shortMs = expectation.end.getTime() - departure.departureAt.getTime();
  const toleranceMs = expectation.earlyLeaveToleranceMinutes * 60_000;
  return shortMs > toleranceMs ? Math.floor(shortMs / 60_000) : 0;
}

/**
 * PRD 23.2 (v1.28): minutes the employee stayed after the end of their duty, or 0 when they did not stay late.
 *
 * Counted from the end of the duty, but only when the last exit is more than the same tolerance after it (staying 10 minutes
 * to finish up is not overtime). Only a phone that reported leaving counts (`LEFT`); the departure window of
 * `deriveDeparture` (4 h after the end) caps it, and a phone that never reported leaving is never guessed.
 */
export function overtimeMinutes(input: { expectation: Expectation; departure: Departure }): number {
  const { expectation, departure } = input;
  if (!expectation.expected || departure.state !== "LEFT" || departure.departureAt === null)
    return 0;
  const overMs = departure.departureAt.getTime() - expectation.end.getTime();
  const toleranceMs = expectation.earlyLeaveToleranceMinutes * 60_000;
  return overMs > toleranceMs ? Math.floor(overMs / 60_000) : 0;
}
