import { describe, expect, it } from "vitest";
import { holidayCovers, isHoliday, type Holiday } from "../../src";

const holiday = (over: Partial<Holiday>): Holiday => ({
  fromDate: "2026-01-01",
  toDate: "2026-01-01",
  repeatsYearly: false,
  appliesToAll: true,
  locationIds: [],
  ...over,
});

describe("holidayCovers (PRD 14.2)", () => {
  it("covers every day of a one-off range, inclusive", () => {
    const h = holiday({ fromDate: "2026-02-17", toDate: "2026-02-19" });
    expect(
      ["2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20"].map((d) =>
        holidayCovers(h, d),
      ),
    ).toEqual([false, true, true, true, false]);
    expect(holidayCovers(h, "2027-02-18")).toBe(false); // does not repeat
  });

  it("a yearly holiday repeats in later years but never before its first occurrence", () => {
    const h = holiday({ fromDate: "2026-07-11", toDate: "2026-07-13", repeatsYearly: true });
    expect(holidayCovers(h, "2027-07-12")).toBe(true);
    expect(holidayCovers(h, "2030-07-13")).toBe(true);
    expect(holidayCovers(h, "2027-07-14")).toBe(false);
    expect(holidayCovers(h, "2025-07-12")).toBe(false); // would rewrite past attendance
  });

  it("finds a range that crosses New Year from the previous year's start", () => {
    const h = holiday({ fromDate: "2026-12-30", toDate: "2027-01-02", repeatsYearly: true });
    for (const covered of [
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-12-31",
      "2028-01-02",
    ]) {
      expect(holidayCovers(h, covered)).toBe(true);
    }
    for (const free of ["2026-12-29", "2027-01-03", "2027-12-29", "2028-01-03"]) {
      expect(holidayCovers(h, free)).toBe(false);
    }
  });

  it("a 29 February holiday falls on 28 February in years without one", () => {
    const h = holiday({ fromDate: "2024-02-29", toDate: "2024-02-29", repeatsYearly: true });
    expect(holidayCovers(h, "2024-02-29")).toBe(true);
    expect(holidayCovers(h, "2025-02-28")).toBe(true);
    expect(holidayCovers(h, "2025-03-01")).toBe(false);
    expect(holidayCovers(h, "2028-02-29")).toBe(true);
    expect(holidayCovers(h, "2028-02-28")).toBe(false);
  });
});

describe("isHoliday scoping", () => {
  it("applies to all locations, or only to the listed ones", () => {
    const everywhere = holiday({ fromDate: "2026-10-12", toDate: "2026-10-12" });
    const centralOnly = holiday({
      fromDate: "2026-10-13",
      toDate: "2026-10-13",
      appliesToAll: false,
      locationIds: ["central"],
    });
    const list = [everywhere, centralOnly];
    expect(isHoliday(list, "naiman", "2026-10-12")).toBe(true);
    expect(isHoliday(list, "central", "2026-10-13")).toBe(true);
    expect(isHoliday(list, "naiman", "2026-10-13")).toBe(false);
    expect(isHoliday(list, "central", "2026-10-14")).toBe(false);
    expect(isHoliday([], "central", "2026-10-12")).toBe(false);
  });
});
