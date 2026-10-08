import { describe, expect, it } from "vitest";
import { deriveOffDayStatus, deriveStatus, type Expectation } from "../../src";

const t = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);
const expected: Expectation = {
  expected: true,
  source: "STANDARD",
  workDate: "2026-10-06",
  locationId: "L1",
  timeZone: "UTC",
  shiftTemplateId: null,
  start: t("08:00"),
  end: t("17:00"),
  graceMinutes: 15,
  cutoff: t("17:00"), // the end of the duty (PRD 6.3)
  earlyWindowStart: t("06:00"),
  minStayMinutes: 3,
};
const enter = (hhmm: string) => ({ type: "ENTER" as const, at: t(hhmm) });
const exit = (hhmm: string) => ({ type: "EXIT" as const, at: t(hhmm) });
const run = (over: Partial<Parameters<typeof deriveStatus>[0]>) =>
  deriveStatus({ expectation: expected, events: [], hasReason: false, now: t("12:00"), ...over });

describe("deriveStatus (PRD 6.6)", () => {
  it("ON_TIME within grace (6.2)", () => {
    expect(run({ events: [enter("08:15")] })).toMatchObject({ status: "ON_TIME", lateMinutes: 0 });
  });
  it("LATE after grace with minutes since start (6.2)", () => {
    expect(run({ events: [enter("08:24")] })).toMatchObject({ status: "LATE", lateMinutes: 24 });
  });
  it("a very late arrival is still LATE, never NO_SHOW (6.3)", () => {
    expect(run({ events: [enter("12:30")], now: t("13:00") })).toMatchObject({
      status: "LATE",
      lateMinutes: 270,
    });
  });
  it("PENDING all day without arrival, even hours after the start", () => {
    expect(run({ now: t("10:00") }).status).toBe("PENDING");
    expect(run({ now: t("16:59") }).status).toBe("PENDING");
  });
  it("NO_SHOW once the duty is over without arrival (6.3)", () => {
    expect(run({ now: t("17:00") }).status).toBe("NO_SHOW");
  });
  it("arriving long before the start is on time (6.2)", () => {
    expect(run({ events: [enter("06:30")], now: t("09:00") })).toMatchObject({
      status: "ON_TIME",
      lateMinutes: 0,
    });
  });
  it("a stay shorter than the minimum does not confirm (6.4)", () => {
    expect(run({ events: [enter("08:00"), exit("08:02")], now: t("09:00") }).status).toBe(
      "PENDING",
    );
    expect(run({ events: [enter("08:00"), exit("08:02")], now: t("17:00") }).status).toBe(
      "NO_SHOW",
    );
  });
  it("an ENTER still in progress is not confirmed until the minimum stay passed", () => {
    expect(run({ events: [enter("08:00")], now: t("08:02") }).status).toBe("PENDING");
    expect(run({ events: [enter("08:00")], now: t("08:03") }).status).toBe("ON_TIME");
  });
  it("reason wins over arrival and over no-show (6.6)", () => {
    expect(run({ hasReason: true }).status).toBe("EXCUSED");
    expect(run({ hasReason: true, events: [enter("08:00")] }).status).toBe("EXCUSED");
  });
  it("ignores events before the early window (23.2)", () => {
    expect(run({ events: [enter("05:00"), exit("05:30")], now: t("09:00") }).status).toBe(
      "PENDING",
    );
  });
  it("not expected / not configured pass through", () => {
    expect(run({ expectation: { expected: false, reason: "HOLIDAY" } }).status).toBe(
      "NOT_EXPECTED",
    );
    expect(
      run({ expectation: { expected: false, reason: "NOT_CONFIGURED", missing: "WORKING_WEEK" } })
        .status,
    ).toBe("NOT_CONFIGURED");
  });
});

describe("deriveOffDayStatus (6.1)", () => {
  const holiday: Expectation = { expected: false, reason: "HOLIDAY" };
  it("confirmed stay on a holiday is WORKED_OFF_DAY", () => {
    expect(deriveOffDayStatus(holiday, [enter("09:00")], 3, t("12:00")).status).toBe(
      "WORKED_OFF_DAY",
    );
  });
  it("no stay → NOT_EXPECTED; inactive never WORKED_OFF_DAY", () => {
    expect(deriveOffDayStatus(holiday, [], 3, t("12:00")).status).toBe("NOT_EXPECTED");
    expect(
      deriveOffDayStatus({ expected: false, reason: "INACTIVE" }, [enter("09:00")], 3, t("12:00"))
        .status,
    ).toBe("NOT_EXPECTED");
  });
});
