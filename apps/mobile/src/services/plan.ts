import type { Plan, PlanPlace } from "@/lib/api";

/** iOS watches at most 20 regions per app (Architecture 7.3); Android is generous but the radius should be 100 m or more (PRD 13). */
export const MAX_REGIONS = 20;
export const MIN_RADIUS_M = 100;

export interface Region {
  identifier: string;
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter: true;
  notifyOnExit: true;
}

/**
 * The geofences to register from the server's plan: every place of the coming days once, the places of today first (so that the
 * 20-region limit of iOS never drops the one the person is expected at today). Nothing is watched when nobody is expected anywhere.
 */
export function regionsFromPlan(plan: Plan): Region[] {
  const order: string[] = [];
  for (const day of plan.days) {
    if (!day.expected) continue;
    for (const place of [...day.locations].sort((a, b) => Number(b.main) - Number(a.main))) {
      if (!order.includes(place.id)) order.push(place.id);
    }
  }
  const byId = new Map<string, PlanPlace>(plan.places.map((p) => [p.id, p]));
  return order.slice(0, MAX_REGIONS).flatMap((id) => {
    const p = byId.get(id);
    return p
      ? [
          {
            identifier: p.id,
            latitude: p.lat,
            longitude: p.lng,
            radius: Math.max(p.radiusM, MIN_RADIUS_M),
            notifyOnEnter: true as const,
            notifyOnExit: true as const,
          },
        ]
      : [];
  });
}

/** True when the new plan watches different places than the registered regions (so the phone only re-registers when it must). */
export function regionsChanged(a: readonly Region[], b: readonly Region[]): boolean {
  const key = (r: Region) => `${r.identifier}:${r.latitude}:${r.longitude}:${r.radius}`;
  const left = a.map(key).sort().join("|");
  const right = b.map(key).sort().join("|");
  return left !== right;
}
