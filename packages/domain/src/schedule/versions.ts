import type { DateString } from "./dates";
import type { Versioned } from "./types";

/** Is a half-open validity range [validFrom, validTo) in force on `date`? */
export const inForce = (v: Versioned, date: DateString): boolean =>
  v.validFrom <= date && (v.validTo === null || date < v.validTo);

/**
 * The version in force on `date` for a location: its own version when `allowLocationVersion` is true and one
 * exists, otherwise the tenant default (locationId null). The database guarantees at most one per scope and date.
 */
export function pickVersion<T extends Versioned>(
  versions: readonly T[],
  locationId: string,
  date: DateString,
  allowLocationVersion = true,
): T | undefined {
  if (allowLocationVersion) {
    const own = versions.find((v) => v.locationId === locationId && inForce(v, date));
    if (own) return own;
  }
  return versions.find((v) => v.locationId === null && inForce(v, date));
}
