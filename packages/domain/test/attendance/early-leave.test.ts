import { describe, expect, it } from "vitest";
import { earlyLeaveMinutes, type Departure, type Expectation } from "../../src";

const t = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);
const expected: Expectation = {
  expected: true,
  source: "STANDARD",
  workDate: "2026-10-06",
  locationId: "L1",
  locationIds: ["L1"],
  timeZone: "UTC",
  shiftTemplateId: null,
  start: t("08:00"),
  end: t("17:00"),
  graceMinutes: 15,
  earlyLeaveToleranceMinutes: 15,
  cutoff: t("17:00"),
  earlyWindowStart: t("00:00"),
  minStayMinutes: 3,
};
const left = (hhmm: string): Departure => ({ state: "LEFT", departureAt: t(hhmm) });
const run = (departure: Departure, expectation: Expectation = expected) =>
  earlyLeaveMinutes({ expectation, departure });

describe("earlyLeaveMinutes (PRD 23.2)", () => {
  it("counts the minutes before the end of the duty", () => {
    expect(run(left("14:10"))).toBe(170);
    expect(run(left("16:00"))).toBe(60);
  });
  it("tolerates leaving a little early: only more than the tolerance counts", () => {
    expect(run(left("16:45"))).toBe(0); // exactly 15 min
    expect(run(left("16:44"))).toBe(16);
    expect(run(left("17:00"))).toBe(0);
    expect(run(left("18:30"))).toBe(0);
  });
  it("the tolerance comes from the rules in force", () => {
    expect(run(left("16:45"), { ...expected, earlyLeaveToleranceMinutes: 0 })).toBe(15);
    expect(run(left("16:00"), { ...expected, earlyLeaveToleranceMinutes: 60 })).toBe(0);
  });
  it("never guesses: still inside, unknown, no arrival, or a day nobody is expected", () => {
    expect(run({ state: "INSIDE", departureAt: null })).toBe(0);
    expect(run({ state: "UNKNOWN", departureAt: null })).toBe(0);
    expect(run({ state: null, departureAt: null })).toBe(0);
    expect(run(left("12:00"), { expected: false, reason: "HOLIDAY" })).toBe(0);
  });
});
