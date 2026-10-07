import { describe, expect, it } from "vitest";
import { candidateWorkDates, instantToLocalDate, zonedTimeToInstant } from "../../src";

describe("zonedTimeToInstant", () => {
  it("converts Ulaanbaatar wall-clock times (UTC+8) to UTC", () => {
    expect(zonedTimeToInstant("2026-10-05", "08:30", "Asia/Ulaanbaatar").toISOString()).toBe(
      "2026-10-05T00:30:00.000Z",
    );
    expect(zonedTimeToInstant("2026-10-05", "00:00", "Asia/Ulaanbaatar").toISOString()).toBe(
      "2026-10-04T16:00:00.000Z",
    );
    expect(zonedTimeToInstant("2026-10-05", "23:59:30", "Asia/Ulaanbaatar").toISOString()).toBe(
      "2026-10-05T15:59:30.000Z",
    );
  });

  it("follows daylight-saving changes in other zones", () => {
    expect(zonedTimeToInstant("2026-07-01", "08:00", "America/New_York").toISOString()).toBe(
      "2026-07-01T12:00:00.000Z",
    );
    expect(zonedTimeToInstant("2026-12-01", "08:00", "America/New_York").toISOString()).toBe(
      "2026-12-01T13:00:00.000Z",
    );
    // The morning of the spring-forward day: 08:00 is already summer time.
    expect(zonedTimeToInstant("2026-03-08", "08:00", "America/New_York").toISOString()).toBe(
      "2026-03-08T12:00:00.000Z",
    );
  });

  it("handles UTC and zones with half-hour offsets", () => {
    expect(zonedTimeToInstant("2026-10-05", "08:30", "UTC").toISOString()).toBe(
      "2026-10-05T08:30:00.000Z",
    );
    expect(zonedTimeToInstant("2026-10-05", "08:30", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-05T03:00:00.000Z",
    );
  });
});

describe("instantToLocalDate and candidateWorkDates", () => {
  it("uses the calendar date of the zone, not of UTC", () => {
    const instant = new Date("2026-10-06T20:30:00Z"); // 04:30 on the 7th in Ulaanbaatar
    expect(instantToLocalDate(instant, "Asia/Ulaanbaatar")).toBe("2026-10-07");
    expect(instantToLocalDate(instant, "UTC")).toBe("2026-10-06");
  });

  it("offers the local date and the day before (a duty lasts at most 24 h, PRD 23.2)", () => {
    // 01:30 on the 7th local: could belong to the night shift that started on the 6th.
    expect(candidateWorkDates(new Date("2026-10-06T17:30:00Z"), "Asia/Ulaanbaatar")).toEqual([
      "2026-10-06",
      "2026-10-07",
    ]);
    expect(candidateWorkDates(new Date("2026-10-31T17:30:00Z"), "Asia/Ulaanbaatar")).toEqual([
      "2026-10-31",
      "2026-11-01",
    ]);
  });

  it("round-trips with zonedTimeToInstant", () => {
    const instant = zonedTimeToInstant("2026-10-05", "00:10", "Asia/Ulaanbaatar");
    expect(instantToLocalDate(instant, "Asia/Ulaanbaatar")).toBe("2026-10-05");
  });
});
