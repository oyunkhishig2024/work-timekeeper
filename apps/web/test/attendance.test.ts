import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  barSegments,
  countFor,
  dashboardHref,
  explain,
  formatTime,
  isIsoDate,
  parseDashboardState,
  rateFor,
  weekdayMn,
  type DailyRow,
  type Figures,
} from "../src/lib/attendance";

const figures = (over: Partial<Figures> = {}): Figures => ({
  total: 220,
  onTime: 212,
  late: 2,
  excused: 3,
  noShow: 3,
  pending: 0,
  onTimeRate: 96.4,
  lateRate: 0.9,
  excusedRate: 1.4,
  noShowRate: 1.4,
  ...over,
});

const row = (over: Partial<DailyRow>): DailyRow => ({
  employeeId: "e1",
  employeeNo: "2026100800000001",
  fullName: "Бат Болд",
  rank: "Ахмад",
  position: "Нярав",
  departmentId: "d1",
  departmentName: "Агуулах",
  locationId: "l1",
  locationName: "Төв салбар",
  status: "ON_TIME",
  arrivalAt: null,
  lateMinutes: 0,
  reasonName: null,
  expectedStart: null,
  source: "AUTO",
  flaggedEvents: 0,
  ...over,
});

describe("dates", () => {
  it("adds days across month and year ends without touching the machine's zone", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2026-10-08")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-1-8")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
  it("names the weekday in Mongolian (2026-10-08 is a Thursday)", () => {
    expect(weekdayMn("2026-10-08")).toBe("Пүрэв");
    expect(weekdayMn("2026-10-11")).toBe("Ням");
    expect(weekdayMn("2026-10-12")).toBe("Даваа");
  });
  it("shows times in the organization's zone", () => {
    expect(formatTime("2026-10-08T00:24:00Z", "Asia/Ulaanbaatar")).toBe("08:24");
    expect(formatTime("2026-10-08T00:24:00Z", "UTC")).toBe("00:24");
    expect(formatTime(null, "UTC")).toBeNull();
  });
});

describe("explain: what happened that day", () => {
  const tz = "Asia/Ulaanbaatar";
  it("on time and late show the arrival; late adds the minutes", () => {
    expect(explain(row({ status: "ON_TIME", arrivalAt: "2026-10-08T00:24:00Z" }), tz)).toBe(
      "08:24-д ирсэн",
    );
    expect(
      explain(row({ status: "LATE", arrivalAt: "2026-10-08T00:47:00Z", lateMinutes: 47 }), tz),
    ).toBe("08:47-д ирсэн · 47 минут хоцорсон");
  });
  it("excused shows the reason (and the arrival when there was one)", () => {
    expect(explain(row({ status: "EXCUSED", reasonName: "Өвчтэй" }), tz)).toBe("Өвчтэй");
    expect(
      explain(
        row({ status: "EXCUSED", reasonName: "Томилолт", arrivalAt: "2026-10-08T01:00:00Z" }),
        tz,
      ),
    ).toBe("Томилолт · 09:00-д ирсэн");
  });
  it("no show says that nothing was recorded and no reason was given", () => {
    expect(explain(row({ status: "NO_SHOW", expectedStart: "2026-10-08T00:00:00Z" }), tz)).toBe(
      "Ирсэн бүртгэлгүй (эхлэх цаг 08:00) · шалтгаан оноогоогүй",
    );
  });
  it("pending says the time has not come", () => {
    expect(explain(row({ status: "PENDING", expectedStart: "2026-10-08T01:00:00Z" }), tz)).toBe(
      "Эхлэх цаг 09:00, ирэх цаг болоогүй",
    );
  });
});

describe("figures", () => {
  it("stacked bar widths add up to 100 and skip empty parts", () => {
    const segments = barSegments(figures());
    expect(segments.map((s) => s.key)).toEqual(["ON_TIME", "LATE", "EXCUSED", "NO_SHOW"]);
    expect(segments.reduce((n, s) => n + s.percent, 0)).toBeCloseTo(100, 6);
    expect(segments[0]!.percent).toBeCloseTo((212 / 220) * 100, 6);
  });
  it("nobody expected: no bar", () => {
    expect(barSegments(figures({ total: 0, onTime: 0, late: 0, excused: 0, noShow: 0 }))).toEqual(
      [],
    );
  });
  it("counts and rates per status (the total has no rate)", () => {
    const f = figures({ pending: 5 });
    expect(countFor(f, "EXPECTED")).toBe(220);
    expect(countFor(f, "PENDING")).toBe(5);
    expect(rateFor(f, "ON_TIME")).toBe(96.4);
    expect(rateFor(f, "EXPECTED")).toBeNull();
  });
});

describe("the dashboard URL", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const params = (q: string) => new URLSearchParams(q);
  it("round-trips the state", () => {
    const state = {
      date: "2026-10-07",
      status: "NO_SHOW" as const,
      locationId: id,
      departmentId: null,
      by: "location" as const,
    };
    expect(dashboardHref(state)).toBe(`/dashboard?date=2026-10-07&status=NO_SHOW&location=${id}`);
    expect(parseDashboardState(params(dashboardHref(state).split("?")[1]!))).toEqual(state);
    expect(dashboardHref({})).toBe("/dashboard");
    expect(dashboardHref({ by: "department", date: "2026-10-07" })).toBe(
      "/dashboard?date=2026-10-07&by=department",
    );
  });
  it("ignores anything it does not recognise instead of passing it on to the API", () => {
    expect(
      parseDashboardState(
        params("date=tomorrow&status=BOGUS&location=x%27%20OR%201%3D1&department=..%2F..&by=weird"),
      ),
    ).toEqual({ date: null, status: null, locationId: null, departmentId: null, by: "location" });
  });
});
