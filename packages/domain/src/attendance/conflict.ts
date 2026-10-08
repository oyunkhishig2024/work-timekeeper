import type { Fix } from "./plausibility";

/**
 * PRD 6.7 buddy punching: two employees' devices at identical coordinates with identical movement. Independent phones
 * never report the same position to the metre again and again, so repeated coincidences point to one device or to
 * spoofing. Several matches are required: standing next to each other once is normal.
 */
export const CONFLICT_MAX_GAP_SECONDS = 120;
/** 5 decimals of a degree is about 1.1 m. */
export const CONFLICT_DECIMALS = 5;
export const CONFLICT_MIN_MATCHES = 3;

const roundTo = (value: number, decimals: number) => Number(value.toFixed(decimals));

export function sameSpot(
  a: Pick<Fix, "lat" | "lng">,
  b: Pick<Fix, "lat" | "lng">,
  decimals: number = CONFLICT_DECIMALS,
): boolean {
  return (
    roundTo(a.lat, decimals) === roundTo(b.lat, decimals) &&
    roundTo(a.lng, decimals) === roundTo(b.lng, decimals)
  );
}

/**
 * Which of `mine` have a fix in `theirs` at the same spot within the gap. Each of mine appears at most once, so a burst of
 * repeated fixes by the other device does not inflate the result.
 */
export function matchedFixes(
  mine: readonly Fix[],
  theirs: readonly Fix[],
  maxGapSeconds: number = CONFLICT_MAX_GAP_SECONDS,
  decimals: number = CONFLICT_DECIMALS,
): Fix[] {
  return mine.filter((m) =>
    theirs.some(
      (t) =>
        Math.abs(t.at.getTime() - m.at.getTime()) <= maxGapSeconds * 1000 &&
        sameSpot(m, t, decimals),
    ),
  );
}

export const CONFLICT_MIN_DISTINCT_SPOTS = 2;

/**
 * A conflict needs at least three coincidences at two or more different places: a trace that moves together. Many matches at
 * one single place can be two phones sharing a cached network position, not a shared journey.
 */
export function isTraceConflict(
  matched: readonly Fix[],
  minMatches: number = CONFLICT_MIN_MATCHES,
  minDistinctSpots: number = CONFLICT_MIN_DISTINCT_SPOTS,
  decimals: number = CONFLICT_DECIMALS,
): boolean {
  if (matched.length < minMatches) return false;
  const spots = new Set(
    matched.map((f) => `${roundTo(f.lat, decimals)},${roundTo(f.lng, decimals)}`),
  );
  return spots.size >= minDistinctSpots;
}
