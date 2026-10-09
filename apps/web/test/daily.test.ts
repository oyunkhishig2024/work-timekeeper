import { describe, expect, it } from "vitest";
import {
  correctionFormProblem,
  dailyHref,
  dailyQuery,
  departureText,
  offDayLabel,
  isReasonAssignable,
  overlapNames,
  parseDailyState,
  personalHoursProblem,
  reasonFormProblem,
  type Reason,
} from "../src/lib/daily";
import { isoToZonedTime, zonedTimeToIso } from "../src/lib/time";

describe("zonedTimeToIso", () => {
  it("converts the organization's wall clock to an instant (Ulaanbaatar is UTC+8 all year)", () => {
    expect(zonedTimeToIso("2026-10-06", "08:30", "Asia/Ulaanbaatar")).toBe(
      "2026-10-06T00:30:00.000Z",
    );
    expect(zonedTimeToIso("2026-01-15", "00:10", "Asia/Ulaanbaatar")).toBe(
      "2026-01-14T16:10:00.000Z",
    ); // the previous UTC day
    expect(zonedTimeToIso("2026-10-06", "08:30", "UTC")).toBe("2026-10-06T08:30:00.000Z");
  });
  it("handles daylight saving zones on both sides of a change", () => {
    expect(zonedTimeToIso("2026-07-01", "09:00", "America/New_York")).toBe(
      "2026-07-01T13:00:00.000Z",
    ); // UTC-4
    expect(zonedTimeToIso("2026-12-01", "09:00", "America/New_York")).toBe(
      "2026-12-01T14:00:00.000Z",
    ); // UTC-5
    // 2026-03-08 02:30 does not exist in New York; the result lands just after the gap
    expect(zonedTimeToIso("2026-03-08", "03:30", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });
  it("round-trips with isoToZonedTime", () => {
    for (const tz of ["Asia/Ulaanbaatar", "America/New_York", "Europe/London"]) {
      expect(isoToZonedTime(zonedTimeToIso("2026-10-06", "17:45", tz), tz)).toBe("17:45");
    }
  });
});

describe("the daily screen's URL", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  it("round-trips the filters", () => {
    const state = {
      date: "2026-10-07",
      status: "INACTIVE" as const,
      locationId: id,
      departmentId: null,
      q: "бат",
    };
    const href = dailyHref(state);
    expect(parseDailyState(new URLSearchParams(href.split("?")[1]!))).toEqual(state);
    expect(dailyHref({})).toBe("/daily");
  });
  it("drops anything it does not recognise", () => {
    expect(
      parseDailyState(
        new URLSearchParams("date=x&status=EXPECTED&location=1%27&q=" + "a".repeat(300)),
      ),
    ).toEqual({
      date: null,
      status: null, // «Бүгд» is the absence of a status
      locationId: null,
      departmentId: null,
      q: "a".repeat(100),
    });
  });
  it("asks the API for everyone expected unless a status is chosen", () => {
    expect(dailyQuery({ date: "2026-10-07" })).toBe("date=2026-10-07&status=EXPECTED&limit=500");
    expect(dailyQuery({ date: "2026-10-07", status: "NO_SHOW", q: " Бат " })).toBe(
      "date=2026-10-07&status=NO_SHOW&limit=500&q=%D0%91%D0%B0%D1%82",
    );
  });
});

describe("form checks", () => {
  const sick: Reason = { id: "1", name: "Өвчтэй", active: true, requiresDescription: false };
  const other: Reason = { id: "2", name: "Бусад", active: true, requiresDescription: true };
  it("a reason must be chosen, and «Бусад» must be explained", () => {
    expect(reasonFormProblem(undefined, "")).toBe("Шалтгаанаа сонгоно уу.");
    expect(reasonFormProblem(sick, "")).toBeNull();
    expect(reasonFormProblem(other, "  ")).toMatch(/тайлбар/u);
    expect(reasonFormProblem(other, "ab")).toMatch(/тайлбар/u);
    expect(reasonFormProblem(other, "Хурал")).toBeNull();
  });
  it("a correction: no arrival for Ирээгүй, a note for «Бусад»", () => {
    const ok = { status: "ON_TIME" as const, arrival: "08:05", reasonCode: "GPS_FAULT", note: "" };
    expect(correctionFormProblem(ok)).toBeNull();
    expect(correctionFormProblem({ ...ok, status: "NO_SHOW" })).toMatch(/Ирээгүй/u);
    expect(correctionFormProblem({ ...ok, status: "NO_SHOW", arrival: "" })).toBeNull();
    expect(correctionFormProblem({ ...ok, reasonCode: "OTHER" })).toMatch(/тайлбар/u);
    expect(correctionFormProblem({ ...ok, reasonCode: "OTHER", note: "Утас эвдэрсэн" })).toBeNull();
  });
});

describe("bulk reason assignment helpers", () => {
  it("offers a reason only to expected employees who have none", () => {
    expect(isReasonAssignable({ status: "NO_SHOW", reasonName: null })).toBe(true);
    expect(isReasonAssignable({ status: "LATE", reasonName: null })).toBe(true);
    expect(isReasonAssignable({ status: "EXCUSED", reasonName: "Өвчтэй" })).toBe(false);
    expect(isReasonAssignable({ status: "WORKED_OFF_DAY", reasonName: null })).toBe(false);
    expect(isReasonAssignable({ status: "NOT_CONFIGURED", reasonName: null })).toBe(false);
  });

  it("names the selected employees that clash, from the API problem", () => {
    const rows = [
      { employeeId: "a", fullName: "Бат Болд" },
      { employeeId: "b", fullName: "Дорж Сараа" },
    ];
    expect(overlapNames({ conflicts: [{ employeeId: "b" }] }, rows)).toEqual(["Дорж Сараа"]);
    expect(overlapNames(null, rows)).toEqual([]);
    expect(overlapNames({ conflicts: "x" }, rows)).toEqual([]);
  });
});

describe("departureText", () => {
  const fmt = (iso: string | null) => (iso ? iso.slice(11, 16) : null);
  it("shows the time, Байгаа, Тодорхойгүй, or a dash", () => {
    expect(
      departureText({ departureState: "LEFT", departureAt: "2026-10-06T08:10:00Z" }, fmt),
    ).toBe("08:10");
    expect(departureText({ departureState: "INSIDE", departureAt: null }, fmt)).toBe("Байгаа");
    expect(departureText({ departureState: "UNKNOWN", departureAt: null }, fmt)).toBe(
      "Тодорхойгүй",
    );
    expect(departureText({ departureState: null, departureAt: null }, fmt)).toBe("—");
  });
});

describe("personalHoursProblem", () => {
  const ok = { fromDate: "2026-10-07", toDate: "2026-10-08", startTime: "06:30", endTime: "14:00" };
  it("accepts a sensible range and refuses the rest", () => {
    expect(personalHoursProblem(ok)).toBeNull();
    expect(personalHoursProblem({ ...ok, toDate: "2026-10-06" })).toMatch(/Дуусах огноо/);
    expect(personalHoursProblem({ ...ok, endTime: "06:30" })).toMatch(/Дуусах цаг/);
    expect(personalHoursProblem({ ...ok, startTime: "" })).toMatch(/цагаа/);
    expect(personalHoursProblem({ ...ok, toDate: "2026-12-01" })).toMatch(/31 хоног/);
  });
});

describe("offDayLabel", () => {
  it("tells a holiday from a plain day off", () => {
    expect(offDayLabel("HOLIDAY")).toBe("Баярын өдөр ажилласан");
    expect(offDayLabel("OFF_DAY")).toBe("Амралтын өдөр ажилласан");
    expect(offDayLabel(null)).toBe("Амралтын өдөр ажилласан");
  });
});
