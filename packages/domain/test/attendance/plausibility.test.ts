import { describe, expect, it } from "vitest";
import { distanceMeters, impliedSpeedKmh, isImpossibleSpeed, type Fix } from "../../src";

const fix = (min: number, lat: number, lng: number, accuracyM?: number): Fix => ({
  at: new Date(Date.UTC(2026, 9, 6, 0, min)),
  lat,
  lng,
  accuracyM,
});
// Ulaanbaatar city centre and a point about 11.1 km north of it.
const centre = { lat: 47.9187, lng: 106.9176 };

describe("plausibility of consecutive fixes (PRD 6.7)", () => {
  it("measures great-circle distance (0.1 degree of latitude is about 11.1 km)", () => {
    expect(distanceMeters(centre, { lat: centre.lat + 0.1, lng: centre.lng })).toBeCloseTo(
      11_119,
      -1,
    );
  });
  it("11 km in 5 minutes is 133 km/h: plausible by car", () => {
    const v = impliedSpeedKmh(fix(0, centre.lat, centre.lng), fix(5, centre.lat + 0.1, centre.lng));
    expect(v).toBeCloseTo(133.4, 0);
    expect(
      isImpossibleSpeed(fix(0, centre.lat, centre.lng), fix(5, centre.lat + 0.1, centre.lng)),
    ).toBe(false);
  });
  it("11 km in 4 minutes is 167 km/h: impossible", () => {
    expect(
      isImpossibleSpeed(fix(0, centre.lat, centre.lng), fix(4, centre.lat + 0.1, centre.lng)),
    ).toBe(true);
  });
  it("is symmetric in time order", () => {
    expect(
      isImpossibleSpeed(fix(4, centre.lat + 0.1, centre.lng), fix(0, centre.lat, centre.lng)),
    ).toBe(true);
  });
  it("accuracy radii are subtracted: jitter of imprecise fixes is not a teleport", () => {
    // 600 m apart one second later is 2160 km/h raw, but two 300 m radii explain all of it.
    const a = fix(0, centre.lat, centre.lng, 300);
    const b = { ...a, at: new Date(a.at.getTime() + 1000), lat: centre.lat + 0.0054 };
    expect(distanceMeters(a, b)).toBeGreaterThan(590);
    expect(isImpossibleSpeed(a, b)).toBe(false);
    expect(isImpossibleSpeed({ ...a, accuracyM: 5 }, { ...b, accuracyM: 5 })).toBe(true);
  });
  it("the same instant at two places is impossible, at the same place is not", () => {
    expect(
      isImpossibleSpeed(fix(0, centre.lat, centre.lng), fix(0, centre.lat + 0.1, centre.lng)),
    ).toBe(true);
    expect(isImpossibleSpeed(fix(0, centre.lat, centre.lng), fix(0, centre.lat, centre.lng))).toBe(
      false,
    );
  });
  it("the limit is configurable", () => {
    const a = fix(0, centre.lat, centre.lng);
    const b = fix(5, centre.lat + 0.1, centre.lng);
    expect(isImpossibleSpeed(a, b, 100)).toBe(true);
  });
});
