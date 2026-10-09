import { describe, expect, it } from "vitest";
import {
  deriveDeparture,
  deriveOffDayDeparture,
  type Expectation,
  type GeofenceEvent,
} from "../../src";

const t = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);
const expected: Expectation = {
  expected: true,
  source: "STANDARD",
  workDate: "2026-10-06",
  locationId: "L1",
  locationIds: ["L1"],
  timeZone: "UTC",
  shiftTemplateId: null,
  start: t("08:00"),
  end: t("17:00"),
  graceMinutes: 15,
  earlyLeaveToleranceMinutes: 15,
  cutoff: t("17:00"),
  earlyWindowStart: t("00:00"),
  minStayMinutes: 3,
};
const enter = (hhmm: string) => ({ type: "ENTER" as const, at: t(hhmm) });
const exit = (hhmm: string) => ({ type: "EXIT" as const, at: t(hhmm) });
/** The next calendar day: "25:40" is 01:40 after midnight. */
const nd = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(2026, 9, 6, h, m));
};
const enterN = (hhmm: string) => ({ type: "ENTER" as const, at: nd(hhmm) });
const exitN = (hhmm: string) => ({ type: "EXIT" as const, at: nd(hhmm) });
const run = (
  events: GeofenceEvent[],
  now: string | Date,
  arrival: string | null = "08:00",
  lastSeenAt?: Date | null,
) =>
  deriveDeparture({
    expectation: expected,
    events,
    arrivalAt: arrival ? t(arrival) : null,
    now: typeof now === "string" ? t(now) : now,
    lastSeenAt,
  });

describe("deriveDeparture (PRD 6.4, 23.2)", () => {
  it("is the last EXIT after the arrival", () => {
    expect(run([enter("08:00"), exit("14:10")], "15:00")).toEqual({
      state: "LEFT",
      departureAt: t("14:10"),
    });
  });
  it("a short walk out and back (lunch) changes nothing: the person is inside again", () => {
    expect(run([enter("08:00"), exit("12:00"), enter("13:00")], "15:00")).toEqual({
      state: "INSIDE",
      departureAt: null,
    });
    expect(run([enter("08:00"), exit("12:00"), enter("13:00"), exit("16:40")], "18:00")).toEqual({
      state: "LEFT",
      departureAt: t("16:40"),
    });
  });
  it("is INSIDE while still there, and UNKNOWN an hour after the duty ended when the phone went silent", () => {
    expect(run([enter("08:00")], "16:00").state).toBe("INSIDE");
    expect(run([enter("08:00")], "17:59").state).toBe("INSIDE");
    expect(run([enter("08:00")], "18:00")).toEqual({ state: "UNKNOWN", departureAt: null });
  });
  it("working late is INSIDE for as long as the phone is heard from, not UNKNOWN", () => {
    const heard = (hhmm: string) => nd(hhmm);
    expect(run([enter("08:00")], nd("24:30"), "08:00", heard("24:20")).state).toBe("INSIDE"); // 00:30
    expect(run([enter("08:00")], nd("24:30"), "08:00", t("20:00")).state).toBe("UNKNOWN"); // silent since 20:00
    expect(run([enter("08:00")], nd("24:30"), "08:00", null).state).toBe("UNKNOWN");
  });
  it("working through the night: the exit at 01:40 is the departure (8 h 10 min after 17:30)", () => {
    const e = { ...expected, end: t("17:30"), cutoff: t("17:30") };
    const d = deriveDeparture({
      expectation: e,
      events: [enter("08:20"), exit("12:30"), enter("13:30"), exitN("25:40")],
      arrivalAt: t("08:20"),
      now: nd("26:00"),
    });
    expect(d).toEqual({ state: "LEFT", departureAt: nd("25:40") });
    expect(d.departureAt!.getTime() - e.end.getTime()).toBe((8 * 60 + 10) * 60_000);
  });
  it("the next morning's arrival is a new visit, not a return: the departure stays at the night exit", () => {
    expect(run([enter("08:00"), exitN("25:40"), enterN("30:25")], nd("31:00"))).toEqual({
      state: "LEFT",
      departureAt: nd("25:40"),
    });
    // a return after a short walk out still counts as the same visit
    expect(
      run([enter("08:00"), exit("19:00"), enter("20:30")], nd("21:00"), "08:00", nd("20:55")).state,
    ).toBe("INSIDE");
  });
  it("has nothing without an arrival, and on a day nobody is expected", () => {
    expect(run([exit("12:00")], "18:00", null)).toEqual({ state: null, departureAt: null });
    expect(
      deriveDeparture({
        expectation: { expected: false, reason: "HOLIDAY" },
        events: [enter("08:00")],
        arrivalAt: t("08:00"),
        now: t("18:00"),
      }).state,
    ).toBeNull();
  });
  it("ignores events before the arrival and more than 12 h after the end of the duty", () => {
    expect(run([exit("07:00"), enter("08:00"), exit("17:30")], "18:00")).toEqual({
      state: "LEFT",
      departureAt: t("17:30"),
    });
    // a stay beyond 12 h after the end of the duty belongs to the next day
    expect(run([enter("08:00"), exitN("30:00")], nd("31:00"))).toEqual({
      state: "UNKNOWN",
      departureAt: null,
    });
  });
  it("an exit before the end of a short shift does not need an ENTER after the arrival (HR-corrected arrival)", () => {
    expect(run([exit("11:00")], "12:00", "08:30")).toEqual({
      state: "LEFT",
      departureAt: t("11:00"),
    });
  });
});

describe("deriveOffDayDeparture (PRD 6.1, 23.2): someone came on a day off", () => {
  const off = (
    events: GeofenceEvent[],
    now: Date,
    arrival = t("10:00"),
    lastSeenAt?: Date | null,
  ) => deriveOffDayDeparture({ events, arrivalAt: arrival, now, lastSeenAt });
  it("is the last exit of the stay", () => {
    expect(off([enter("10:00"), exit("15:20")], t("16:00"))).toEqual({
      state: "LEFT",
      departureAt: t("15:20"),
    });
  });
  it("is INSIDE while the phone is heard from, UNKNOWN once it is silent for an hour", () => {
    expect(off([enter("10:00")], t("12:00"), t("10:00"), t("11:30")).state).toBe("INSIDE");
    expect(off([enter("10:00")], t("12:00"), t("10:00"), t("09:00")).state).toBe("UNKNOWN");
    expect(off([enter("10:00")], t("12:00"), t("10:00"), null).state).toBe("UNKNOWN");
  });
  it("a return after more than 3 h is another visit; a shorter walk out and back is not", () => {
    expect(off([enter("10:00"), exit("11:00"), enter("14:30")], t("15:00"))).toEqual({
      state: "LEFT",
      departureAt: t("11:00"),
    });
    expect(
      off([enter("10:00"), exit("11:00"), enter("13:00")], t("13:30"), t("10:00"), t("13:20"))
        .state,
    ).toBe("INSIDE");
  });
  it("has nothing without an arrival", () => {
    expect(off([exit("15:00")], t("16:00"), null as unknown as Date)).toEqual({
      state: null,
      departureAt: null,
    });
  });
});
