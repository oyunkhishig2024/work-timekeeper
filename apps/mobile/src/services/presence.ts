import type { Region } from "./plan";

export interface Position {
  lat: number;
  lng: number;
  accuracyM?: number;
}

/** Per place: is the phone inside (unknown until a trustworthy fix), and how many fixes in a row were clearly outside. */
export interface PresenceState {
  inside: Record<string, boolean>;
  outsideStreak: Record<string, number>;
}

export interface Transition {
  type: "ENTER" | "EXIT";
  locationId: string;
}

/** A fix less exact than this says nothing about a place a few hundred metres wide. */
export const MAX_ACCURACY_M = 150;
/** Leaving needs this many fixes in a row clearly outside, so one stray GPS jump cannot end the day. */
export const EXIT_CONFIRMATIONS = 2;
/** "Clearly outside" is the radius plus this margin (or the fix's own inaccuracy when that is larger). */
export const EXIT_MARGIN_M = 25;

export const emptyState = (): PresenceState => ({ inside: {}, outsideStreak: {} });

/** Metres between two points (haversine). */
export function distanceM(a: Position, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Keeps only the places still in the plan. */
export function forRegions(state: PresenceState, regions: readonly Region[]): PresenceState {
  const ids = new Set(regions.map((r) => r.identifier));
  const keep = <T>(m: Record<string, T>) =>
    Object.fromEntries(Object.entries(m).filter(([id]) => ids.has(id)));
  return { inside: keep(state.inside), outsideStreak: keep(state.outsideStreak) };
}

/**
 * The phone's own judgement of entering and leaving a place from ordinary position fixes. It is the fallback for phones whose system
 * geofencing never reports (some Android makers), and it also gives an arrival when the app is first opened inside the place.
 *  - first trustworthy fix inside → ENTER; outside → just remembered, nothing to report;
 *  - inside → EXIT only after `EXIT_CONFIRMATIONS` fixes in a row clearly outside;
 *  - outside → ENTER at the first fix inside the radius.
 */
export function evaluateFix(
  state: PresenceState,
  regions: readonly Region[],
  fix: Position,
): { state: PresenceState; transitions: Transition[] } {
  const transitions: Transition[] = [];
  if (fix.accuracyM !== undefined && fix.accuracyM > MAX_ACCURACY_M) return { state, transitions };
  const next: PresenceState = {
    inside: { ...state.inside },
    outsideStreak: { ...state.outsideStreak },
  };
  for (const region of regions) {
    const id = region.identifier;
    const d = distanceM(fix, { lat: region.latitude, lng: region.longitude });
    const insideNow = d <= region.radius;
    const clearlyOutside = d > region.radius + Math.max(EXIT_MARGIN_M, fix.accuracyM ?? 0);
    const was = next.inside[id];

    if (was === true) {
      if (clearlyOutside) {
        const streak = (next.outsideStreak[id] ?? 0) + 1;
        if (streak >= EXIT_CONFIRMATIONS) {
          next.inside[id] = false;
          next.outsideStreak[id] = 0;
          transitions.push({ type: "EXIT", locationId: id });
        } else next.outsideStreak[id] = streak;
      } else next.outsideStreak[id] = 0;
    } else if (insideNow) {
      next.inside[id] = true;
      next.outsideStreak[id] = 0;
      transitions.push({ type: "ENTER", locationId: id });
    } else if (was === undefined && clearlyOutside) {
      next.inside[id] = false;
    }
  }
  return { state: next, transitions };
}

/** A transition the system's geofencing reported: say whether it is news (the fix-based judgement may have reported it already). */
export function applyReported(
  state: PresenceState,
  transition: Transition,
): { state: PresenceState; emit: boolean } {
  const known = state.inside[transition.locationId];
  const nowInside = transition.type === "ENTER";
  if (known === nowInside) return { state, emit: false };
  return {
    state: {
      inside: { ...state.inside, [transition.locationId]: nowInside },
      outsideStreak: { ...state.outsideStreak, [transition.locationId]: 0 },
    },
    emit: true,
  };
}
