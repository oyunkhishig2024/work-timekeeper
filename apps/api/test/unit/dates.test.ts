import { describe, expect, it } from "vitest";
import { isValidIsoDate, subtractMonths, todayIn } from "../../src/common/dates";

describe("todayIn", () => {
  it("uses the calendar date of the time zone, not of UTC", () => {
    const instant = new Date("2026-10-06T20:30:00Z"); // 04:30 on the 7th in Ulaanbaatar (UTC+8)
    expect(todayIn("Asia/Ulaanbaatar", instant)).toBe("2026-10-07");
    expect(todayIn("UTC", instant)).toBe("2026-10-06");
    expect(todayIn("America/Los_Angeles", instant)).toBe("2026-10-06");
  });
});

describe("subtractMonths", () => {
  it.each([
    ["2026-10-07", 12, "2025-10-07"],
    ["2026-03-31", 1, "2026-02-28"],
    ["2024-03-31", 1, "2024-02-29"],
    ["2026-01-15", 2, "2025-11-15"],
    ["2026-10-07", 0, "2026-10-07"],
  ])("%s minus %i months is %s", (date, months, expected) => {
    expect(subtractMonths(date, months)).toBe(expected);
  });
});

describe("isValidIsoDate", () => {
  it("accepts real dates and rejects impossible or malformed ones", () => {
    expect(isValidIsoDate("2026-10-07")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-10-07", "2026/10/07", "", "2026-10-7"]) {
      expect(isValidIsoDate(bad)).toBe(false);
    }
  });
});
