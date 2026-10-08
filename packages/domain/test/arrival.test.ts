import { describe, expect, it } from "vitest";
import { classifyArrival, findConfirmedArrival, isPastCutoff } from "../src";

const t = (hhmmss: string) => new Date(`2026-10-06T${hhmmss}Z`);
const start = t("08:00:00");

describe("classifyArrival (PRD 6.2: start 08:00, grace 15)", () => {
  it.each([
    ["07:45:00", "ON_TIME", 0],
    ["08:00:00", "ON_TIME", 0],
    ["08:15:00", "ON_TIME", 0],
    ["08:15:59", "ON_TIME", 0],
    ["08:16:00", "LATE", 16],
    ["08:24:00", "LATE", 24],
  ] as const)("arrival %s is %s (late %i min)", (arrival, status, lateMinutes) => {
    expect(classifyArrival(start, 15, t(arrival))).toEqual({ status, lateMinutes });
  });
});

describe("findConfirmedArrival (PRD 6.4: minimum stay 3 min)", () => {
  it("PRD example: 08:00 enter, 08:02 exit, 08:03 enter → arrival 08:03", () => {
    const events = [
      { type: "ENTER", at: t("08:00:00") },
      { type: "EXIT", at: t("08:02:00") },
      { type: "ENTER", at: t("08:03:00") },
    ] as const;
    expect(findConfirmedArrival(events, 3, t("08:05:00"))).toBeNull(); // only 2 min inside so far
    expect(findConfirmedArrival(events, 3, t("08:06:00"))).toEqual(t("08:03:00"));
  });

  it("confirms a continuous stay and reports the first ENTER time", () => {
    const events = [
      { type: "ENTER", at: t("08:10:00") },
      { type: "EXIT", at: t("12:00:00") },
    ] as const;
    expect(findConfirmedArrival(events, 3, t("13:00:00"))).toEqual(t("08:10:00"));
  });

  it("ignores a stay shorter than the minimum", () => {
    const events = [
      { type: "ENTER", at: t("08:00:00") },
      { type: "EXIT", at: t("08:02:59") },
    ] as const;
    expect(findConfirmedArrival(events, 3, t("09:00:00"))).toBeNull();
  });

  it("does not change the arrival after it is confirmed", () => {
    const events = [
      { type: "ENTER", at: t("08:00:00") },
      { type: "EXIT", at: t("08:04:00") },
      { type: "ENTER", at: t("08:05:00") },
      { type: "EXIT", at: t("08:06:00") },
    ] as const;
    expect(findConfirmedArrival(events, 3, t("09:00:00"))).toEqual(t("08:00:00"));
  });

  it("sorts events by time before evaluating", () => {
    const events = [
      { type: "EXIT", at: t("08:05:00") },
      { type: "ENTER", at: t("08:00:00") },
    ] as const;
    expect(findConfirmedArrival(events, 3, t("09:00:00"))).toEqual(t("08:00:00"));
  });
});

describe("no-show cut-off (PRD 6.3: the end of the duty)", () => {
  const end = t("17:00:00");
  it("is reached at, not before, the end", () => {
    expect(isPastCutoff(t("16:59:59"), end)).toBe(false);
    expect(isPastCutoff(t("17:00:00"), end)).toBe(true);
  });
});
