import { describe, expect, it } from "vitest";
import {
  ATTESTATION_ESCALATION_STREAK,
  attestationFlag,
  isTraceConflict,
  matchedFixes,
  nextUnavailableStreak,
  reachesEscalation,
  sameSpot,
  type Fix,
} from "../../src";

const fix = (sec: number, lat: number, lng: number): Fix => ({
  at: new Date(Date.UTC(2026, 9, 6, 0, 0, sec)),
  lat,
  lng,
});

describe("attestation of event batches (PRD 6.7)", () => {
  it("flags FAILED and UNAVAILABLE, nothing else", () => {
    expect(attestationFlag("FAILED")).toBe("ATTESTATION_FAILED");
    expect(attestationFlag("UNAVAILABLE")).toBe("ATTESTATION_UNAVAILABLE");
    expect(attestationFlag("OK")).toBeNull();
    expect(attestationFlag("UNVERIFIED")).toBeNull();
  });
  it("counts unavailable verdicts in a row; a given verdict ends the run, switched-off leaves it", () => {
    expect(nextUnavailableStreak(2, "UNAVAILABLE")).toBe(3);
    expect(nextUnavailableStreak(4, "OK")).toBe(0);
    expect(nextUnavailableStreak(4, "FAILED")).toBe(0);
    expect(nextUnavailableStreak(4, "UNVERIFIED")).toBe(4);
  });
  it("escalates exactly when the fifth unavailable verdict in a row arrives", () => {
    expect(ATTESTATION_ESCALATION_STREAK).toBe(5);
    expect(reachesEscalation(3, "UNAVAILABLE")).toBe(false);
    expect(reachesEscalation(4, "UNAVAILABLE")).toBe(true);
    expect(reachesEscalation(5, "UNAVAILABLE")).toBe(false);
    expect(reachesEscalation(4, "OK")).toBe(false);
  });
});

describe("DEVICE_CONFLICT trace matching (PRD 6.7)", () => {
  it("same spot to about a metre", () => {
    expect(sameSpot({ lat: 47.918701, lng: 106.917601 }, { lat: 47.918704, lng: 106.917604 })).toBe(
      true,
    );
    expect(sameSpot({ lat: 47.9187, lng: 106.9176 }, { lat: 47.91872, lng: 106.9176 })).toBe(false);
  });
  it("returns my fixes that have a matching fix of the other device within two minutes", () => {
    const mine = [fix(0, 47.9, 106.9), fix(300, 47.91, 106.91), fix(600, 47.92, 106.92)];
    const theirs = [fix(60, 47.9, 106.9), fix(330, 47.91, 106.91), fix(900, 47.92, 106.92)];
    // the third is the same spot but 5 minutes apart
    expect(matchedFixes(mine, theirs)).toEqual([mine[0], mine[1]]);
  });
  it("a burst of the other device does not count one fix of mine twice", () => {
    expect(matchedFixes([fix(0, 1, 1)], [fix(0, 1, 1), fix(10, 1, 1), fix(20, 1, 1)])).toHaveLength(
      1,
    );
  });
  it("one or two coincidences are normal; three at two different places are a conflict", () => {
    const a = fix(0, 47.9, 106.9);
    const b = fix(300, 47.91, 106.91);
    expect(isTraceConflict([a])).toBe(false);
    expect(isTraceConflict([a, b])).toBe(false);
    expect(isTraceConflict([a, b, fix(600, 47.92, 106.92)])).toBe(true);
  });
  it("three coincidences at one single place are not a shared journey", () => {
    expect(
      isTraceConflict([fix(0, 47.9, 106.9), fix(300, 47.9, 106.9), fix(600, 47.9, 106.9)]),
    ).toBe(false);
  });
});
