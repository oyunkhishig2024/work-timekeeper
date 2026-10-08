/**
 * PRD 6.3: an employee with no arrival and no reason is a no-show only once the duty is over (`cutoff` is the end of the
 * duty). A late arrival, however late, is still Хоцорсон.
 */
export function isPastCutoff(now: Date, cutoff: Date): boolean {
  return now.getTime() >= cutoff.getTime();
}
