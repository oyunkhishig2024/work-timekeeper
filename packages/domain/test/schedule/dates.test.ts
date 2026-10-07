import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  daysInMonth,
  fromEpochDay,
  isLeapYear,
  isoWeekday,
  parseDate,
  positiveMod,
  timeToSeconds,
  toEpochDay,
} from "../../src";

describe("calendar dates", () => {
  it("numbers ISO weekdays Monday = 1 … Sunday = 7", () => {
    expect(isoWeekday("2026-10-05")).toBe(1);
    expect(isoWeekday("2026-10-09")).toBe(5);
    expect(isoWeekday("2026-10-10")).toBe(6);
    expect(isoWeekday("2026-10-11")).toBe(7);
    expect(isoWeekday("1970-01-01")).toBe(4); // a Thursday
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-05", 0)).toBe("2026-10-05");
  });

  it("counts days between dates in both directions", () => {
    expect(daysBetween("2026-10-01", "2026-10-05")).toBe(4);
    expect(daysBetween("2026-10-05", "2026-10-01")).toBe(-4);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2024-01-01", "2025-01-01")).toBe(366);
  });

  it("round-trips epoch days", () => {
    for (const date of ["1970-01-01", "2000-02-29", "2026-10-07", "2099-12-31"]) {
      expect(fromEpochDay(toEpochDay(date))).toBe(date);
    }
  });

  it("knows leap years and month lengths", () => {
    expect([2000, 2024, 2026, 1900].map(isLeapYear)).toEqual([true, true, false, false]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("rejects impossible dates and times", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "26-10-07", "2026/10/07", ""]) {
      expect(() => parseDate(bad)).toThrow(RangeError);
    }
    expect(() => timeToSeconds("24:00")).toThrow(RangeError);
    expect(() => timeToSeconds("8:30")).toThrow(RangeError);
    expect(timeToSeconds("08:30")).toBe(30_600);
    expect(timeToSeconds("17:30:15")).toBe(63_015);
  });

  it("positiveMod is never negative", () => {
    expect(positiveMod(-1, 3)).toBe(2);
    expect(positiveMod(-3, 3)).toBe(0);
    expect(positiveMod(4, 3)).toBe(1);
  });
});
