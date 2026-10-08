/** A reported position fix of a device. `accuracyM` is the horizontal accuracy radius the phone reported. */
export interface Fix {
  at: Date;
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

/** PRD 6.7: consecutive fixes implying more than 150 km/h are not plausible for an employee on foot or in a car. */
export const MAX_PLAUSIBLE_SPEED_KMH = 150;

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle (haversine) distance in metres. */
export function distanceMeters(a: Pick<Fix, "lat" | "lng">, b: Pick<Fix, "lat" | "lng">): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Speed needed to get from one fix to the other, in km/h. The distance is reduced by both accuracy radii, because two
 * imprecise fixes of a person standing still can be hundreds of metres apart; only movement beyond that counts.
 * Fixes at the same instant that cannot be explained by accuracy are infinitely fast.
 */
export function impliedSpeedKmh(a: Fix, b: Fix): number {
  const effective = Math.max(
    0,
    distanceMeters(a, b) - Math.max(0, a.accuracyM ?? 0) - Math.max(0, b.accuracyM ?? 0),
  );
  if (effective === 0) return 0;
  const seconds = Math.abs(b.at.getTime() - a.at.getTime()) / 1000;
  if (seconds === 0) return Number.POSITIVE_INFINITY;
  return (effective / seconds) * 3.6;
}

/** PRD 6.7 IMPOSSIBLE_SPEED: true when the two fixes cannot both be genuine for one person. */
export function isImpossibleSpeed(
  a: Fix,
  b: Fix,
  maxKmh: number = MAX_PLAUSIBLE_SPEED_KMH,
): boolean {
  return impliedSpeedKmh(a, b) > maxKmh;
}
