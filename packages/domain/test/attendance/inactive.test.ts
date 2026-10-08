import { describe, expect, it } from "vitest";
import { isLocationInactive, type InactiveInput } from "../../src";

const t = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);
const base: InactiveInput = {
  status: "PENDING",
  expectedStart: t("08:00"),
  lastSeenAt: t("07:30"),
  hasDevice: true,
  now: t("09:30"),
};

describe("isLocationInactive (PRD 6.5, 6.8)", () => {
  it("silent for more than 60 minutes during the duty, without an arrival", () => {
    expect(isLocationInactive({ ...base, now: t("09:01") })).toBe(true);
    expect(isLocationInactive({ ...base, now: t("09:00") })).toBe(false); // exactly the tolerance
    expect(isLocationInactive({ ...base, status: "NO_SHOW", now: t("11:00") })).toBe(true);
  });
  it("silence counts from the duty start, not from yesterday's last heartbeat", () => {
    const lastNight = { ...base, lastSeenAt: new Date("2026-10-05T10:00:00Z") };
    expect(isLocationInactive({ ...lastNight, now: t("08:30") })).toBe(false);
    expect(isLocationInactive({ ...lastNight, now: t("09:01") })).toBe(true);
  });
  it("never heard from the phone: inactive once the tolerance after the start has passed", () => {
    expect(isLocationInactive({ ...base, lastSeenAt: null, now: t("08:59") })).toBe(false);
    expect(isLocationInactive({ ...base, lastSeenAt: null, now: t("09:01") })).toBe(true);
  });
  it("a recent heartbeat keeps the employee active", () => {
    expect(isLocationInactive({ ...base, lastSeenAt: t("09:10") })).toBe(false);
  });
  it("only people with no arrival yet: arrived, excused and not expected are never flagged", () => {
    for (const status of [
      "ON_TIME",
      "LATE",
      "EXCUSED",
      "WORKED_OFF_DAY",
      "NOT_CONFIGURED",
      "NOT_EXPECTED",
    ] as const) {
      expect(isLocationInactive({ ...base, status }), status).toBe(false);
    }
    expect(isLocationInactive({ ...base, expectedStart: null })).toBe(false);
  });
  it("no registered device means manual attendance, not an inactive location", () => {
    expect(isLocationInactive({ ...base, hasDevice: false })).toBe(false);
  });
  it("only the current duty: before the start and after 24 hours nothing is flagged", () => {
    expect(isLocationInactive({ ...base, now: t("07:00") })).toBe(false);
    expect(isLocationInactive({ ...base, now: new Date("2026-10-07T08:01:00Z") })).toBe(false);
  });
  it("the tolerance can be changed", () => {
    expect(
      isLocationInactive({
        ...base,
        lastSeenAt: t("09:00"),
        now: t("09:31"),
        toleranceMinutes: 30,
      }),
    ).toBe(true);
  });
});
