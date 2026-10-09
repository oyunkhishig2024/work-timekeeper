import { describe, expect, it } from "vitest";
import {
  exportPath,
  formatHm,
  parseReportsState,
  periodOf,
  reportsHref,
  shiftPeriod,
  timeReportQuery,
} from "../src/lib/reports";

describe("periodOf", () => {
  it("a week runs Monday to Sunday", () => {
    expect(periodOf("week", "2026-10-07")).toEqual({ from: "2026-10-05", to: "2026-10-11" }); // a Wednesday
    expect(periodOf("week", "2026-10-05")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(periodOf("week", "2026-10-11")).toEqual({ from: "2026-10-05", to: "2026-10-11" }); // a Sunday
    expect(periodOf("week", "2026-12-31")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
  it("a month runs from the first to the last day", () => {
    expect(periodOf("month", "2026-10-07")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodOf("month", "2026-02-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodOf("month", "2028-02-29")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(periodOf("month", "2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("shiftPeriod", () => {
  it("moves a week or a month at a time", () => {
    expect(shiftPeriod("week", "2026-10-07", -1)).toBe("2026-09-30");
    expect(shiftPeriod("week", "2026-10-07", 1)).toBe("2026-10-14");
    expect(shiftPeriod("month", "2026-10-31", -1)).toBe("2026-09-01");
    expect(shiftPeriod("month", "2026-12-15", 1)).toBe("2027-01-01");
    expect(shiftPeriod("month", "2026-01-31", -1)).toBe("2025-12-01");
  });
});

describe("formatHm", () => {
  it("shows hours and minutes, or a dash", () => {
    expect(formatHm(0)).toBe("—");
    expect(formatHm(5)).toBe("0:05");
    expect(formatHm(95)).toBe("1:35");
    expect(formatHm(600)).toBe("10:00");
  });
});

describe("report URL state", () => {
  it("round-trips and ignores nonsense", () => {
    const s = parseReportsState(
      new URLSearchParams("type=overtime&period=month&date=2026-10-07&location=1%27"),
    );
    expect(s).toEqual({
      kind: "overtime",
      period: "month",
      date: "2026-10-07",
      locationId: null,
      departmentId: null,
    });
    expect(reportsHref(s)).toBe("/reports?type=overtime&period=month&date=2026-10-07");
    expect(reportsHref({})).toBe("/reports");
    expect(parseReportsState(new URLSearchParams("type=x&period=y&date=2026-02-30"))).toEqual({
      kind: "short",
      period: "week",
      date: null,
      locationId: null,
      departmentId: null,
    });
  });
  it("builds the query and the export of the same report", () => {
    const s = { kind: "short" as const, locationId: null, departmentId: null };
    const r = { from: "2026-10-05", to: "2026-10-11" };
    expect(timeReportQuery(s, r)).toBe("kind=short&from=2026-10-05&to=2026-10-11&limit=500");
    expect(exportPath(s, r, "xlsx")).toBe(
      "/v1/exports/short-hours?format=xlsx&from=2026-10-05&to=2026-10-11",
    );
    expect(exportPath({ ...s, kind: "overtime" }, r, "csv")).toContain(
      "/v1/exports/overtime?format=csv",
    );
  });
});
