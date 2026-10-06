import { addMinutes } from "./time";

/** PRD 6.3: no-show cut-off = start + cutoffHours (default 2). */
export function noShowCutoff(start: Date, cutoffHours: number): Date {
  return addMinutes(start, cutoffHours * 60);
}

/** True once an employee with no arrival and no reason must be shown as NO_SHOW. */
export function isPastCutoff(now: Date, cutoff: Date): boolean {
  return now.getTime() >= cutoff.getTime();
}
