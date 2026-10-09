import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { at, attendanceKit, WORK_DATE } from "./attendance-kit";
import { createEmployee, createUser, type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("short-hours and overtime reports (PRD 9, 23.2)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  /** A late-and-early employee, an overtime employee, and one who never came (the duty is 08:00-17:00). */
  async function day() {
    const w = await k.world();
    const never = await createEmployee(h, w.tenant, { name: "Цэцэг Бат" });
    k.setClock("08:50");
    await k.send(await k.emp(w), [k.ev(w)]); // 50 min late
    k.setClock("08:55");
    await k.send(await k.second(w), [k.ev(w)]); // also late: 55 min
    k.setClock("16:00");
    await k.send(await k.emp(w), [k.ev(w, { type: "EXIT" })]); // 60 min early
    k.setClock("18:30");
    await k.send(await k.second(w), [k.ev(w, { type: "EXIT" })]); // 90 min of overtime
    k.setClock("19:00");
    await k.tick(w.tenant.id);
    return { w, never };
  }
  const report = async (
    w: Awaited<ReturnType<typeof k.world>>,
    kind: string,
    extra = "",
    token?: string,
  ) => {
    const t = token ?? (await signIn(h, w.hr)).accessToken;
    return k.get(
      t,
      `/v1/attendance/time-report?kind=${kind}&from=${WORK_DATE}&to=${WORK_DATE}${extra}`,
    );
  };

  it("short hours: late + early-leave minutes per employee, and the no-show days", async () => {
    const { w, never } = await day();
    const res = await report(w, "short");
    expect(res.status).toBe(200);
    const items = res.body.items as Array<Record<string, unknown>>;
    const mine = items.find((r) => r.employeeId === w.employee.id)!;
    expect(mine).toMatchObject({
      attendedDays: 1,
      lateDays: 1,
      lateMinutes: 50,
      earlyLeaveDays: 1,
      earlyLeaveMinutes: 60,
      shortMinutes: 110,
      noShowDays: 0,
    });
    const other = items.find((r) => r.employeeId === w.second.employee.id)!;
    expect(other).toMatchObject({ lateMinutes: 55, earlyLeaveMinutes: 0, shortMinutes: 55 });
    expect(items.find((r) => r.employeeId === never.id)).toMatchObject({
      attendedDays: 0,
      noShowDays: 1,
      shortMinutes: 0,
    });
    expect(res.body.total).toBe(3);
  });

  it("overtime: only those who stayed after the end, with the minutes", async () => {
    const { w } = await day();
    const res = await report(w, "overtime");
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      employeeId: w.second.employee.id,
      overtimeDays: 1,
      overtimeMinutes: 90,
    });
    // the daily screen and the employee's own history carry the same numbers
    const own = await k.get(
      await k.second(w),
      `/v1/me/attendance?from=${WORK_DATE}&to=${WORK_DATE}`,
    );
    expect(own.body.items[0]).toMatchObject({ overtimeMinutes: 90, departureState: "LEFT" });
    expect(own.body.summary).toMatchObject({ late: 1, overtimeMinutes: 90, shortMinutes: 55 });
  });

  it("is limited to the data scope, validates the period, and exports Excel/CSV/PDF", async () => {
    const { w } = await day();
    expect(
      (await report(w, "short", "&locationId=00000000-0000-4000-8000-000000000000")).body.total,
    ).toBe(0);
    const mgr = (
      await signIn(h, await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" }))
    ).accessToken;
    expect((await report(w, "short", "", mgr)).body.total).toBe(0); // no scope assigned
    expect(
      (
        await k.get(
          (await signIn(h, w.hr)).accessToken,
          `/v1/attendance/time-report?kind=short&from=2026-01-01&to=2026-06-01`,
        )
      ).status,
    ).toBe(400);
    const token = (await signIn(h, w.hr)).accessToken;
    const csv = await h
      .http()
      .get(`/v1/exports/short-hours?format=csv&from=${WORK_DATE}&to=${WORK_DATE}`)
      .set({ Authorization: `Bearer ${token}` });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Дутуу цаг (ц:мм)");
    expect(csv.text).toContain("1:50"); // 110 min
    const ot = await h
      .http()
      .get(`/v1/exports/overtime?format=csv&from=${WORK_DATE}&to=${WORK_DATE}`)
      .set({ Authorization: `Bearer ${token}` });
    expect(ot.text).toContain("Илүү цаг (ц:мм)");
    expect(ot.text).toContain("1:30");
    for (const format of ["xlsx", "pdf"]) {
      const file = await h
        .http()
        .get(`/v1/exports/overtime?format=${format}&from=${WORK_DATE}&to=${WORK_DATE}`)
        .set({ Authorization: `Bearer ${token}` });
      expect(file.status).toBe(200);
    }
  });

  it("working through the night: still inside while the phone is heard, then the exit at 01:40 is 8 h 40 min of overtime", async () => {
    const w = await k.world();
    k.setClock("08:20");
    await k.send(await k.emp(w), [k.ev(w)]);
    await k.send(await k.second(w), [k.ev(w)]);
    // 20:00: the first phone sent a heartbeat a few minutes ago, the second has been silent since the morning
    k.setClock("19:55");
    const phone = await k.emp(w);
    await h
      .http()
      .post("/v1/heartbeat")
      .set({ Authorization: `Bearer ${phone}` });
    k.setClock("20:00");
    await k.tick(w.tenant.id);
    const fresh = async () => (await signIn(h, w.hr)).accessToken;
    const rows = async () =>
      (await k.get(await fresh(), `/v1/attendance/daily?date=${WORK_DATE}`)).body.items as Array<
        Record<string, unknown>
      >;
    const state = async (id: string) => (await rows()).find((r) => r.employeeId === id)!;
    expect(await state(w.employee.id)).toMatchObject({
      departureState: "INSIDE",
      status: "LATE",
    });
    expect(await state(w.second.employee.id)).toMatchObject({ departureState: "UNKNOWN" });

    // the exit comes at 01:40 the next day (17:00 end of the duty -> 8 h 40 min = 520 min)
    k.setClock("25:40");
    await k.send(await k.emp(w), [k.ev(w, { type: "EXIT" })]);
    k.setClock("26:00");
    await k.tick(w.tenant.id);
    expect(await state(w.employee.id)).toMatchObject({
      departureState: "LEFT",
      earlyLeaveMinutes: 0,
    });
    const token = await fresh();
    const ot = await k.get(
      token,
      `/v1/attendance/time-report?kind=overtime&from=${WORK_DATE}&to=${WORK_DATE}`,
    );
    expect(ot.body.items).toHaveLength(1);
    expect(ot.body.items[0]).toMatchObject({ employeeId: w.employee.id, overtimeMinutes: 520 });
    const csv = await h
      .http()
      .get(`/v1/exports/overtime?format=csv&from=${WORK_DATE}&to=${WORK_DATE}`)
      .set({ Authorization: `Bearer ${token}` });
    expect(csv.text).toContain("8:40");
  });

  it("someone who comes on a day off: arrival and departure are recorded and labelled, and nothing is counted from them", async () => {
    const w = await k.world();
    const admin = (await signIn(h, w.admin)).accessToken;
    const off = await k.post(admin, "/v1/working-day-exceptions", {
      date: WORK_DATE,
      working: false,
    });
    expect(off.status).toBeLessThan(300);
    k.setClock("10:00");
    await k.send(await k.emp(w), [k.ev(w)]);
    k.setClock("15:20");
    await k.send(await k.emp(w), [k.ev(w, { type: "EXIT" })]);
    k.setClock("16:00");
    await k.tick(w.tenant.id);
    const token = (await signIn(h, w.hr)).accessToken;

    const day = (await k.get(token, `/v1/attendance/daily?date=${WORK_DATE}&status=WORKED_OFF_DAY`))
      .body;
    expect(day.counts.WORKED_OFF_DAY).toBe(1);
    expect(day.counts.EXPECTED).toBe(0);
    expect(day.items).toHaveLength(1);
    expect(day.items[0]).toMatchObject({
      employeeId: w.employee.id,
      status: "WORKED_OFF_DAY",
      departureState: "LEFT",
      earlyLeaveMinutes: 0,
      offDayKind: "OFF_DAY", // a plain day off, not a holiday
    });
    expect(new Date(day.items[0].arrivalAt).toISOString()).toBe(at("10:00").toISOString());
    expect(new Date(day.items[0].departureAt).toISOString()).toBe(at("15:20").toISOString());

    // never counted as overtime or short hours
    const from = `from=${WORK_DATE}&to=${WORK_DATE}`;
    expect(
      (await k.get(token, `/v1/attendance/time-report?kind=overtime&${from}`)).body.total,
    ).toBe(0);
    expect(
      (await k.get(token, `/v1/attendance/time-report?kind=short&${from}`)).body.items,
    ).toEqual([]);

    // the list for HR
    const list = await k.get(token, `/v1/attendance/off-day-work?${from}`);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      employeeId: w.employee.id,
      date: WORK_DATE,
      departureState: "LEFT",
    });
    const csv = await h
      .http()
      .get(`/v1/exports/off-day-work?format=csv&${from}`)
      .set({ Authorization: `Bearer ${token}` });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Амралтын өдөр ажилласан");
    expect(csv.text).not.toContain("Баярын өдөр");
    expect(csv.text).toContain("10:00");
    expect(csv.text).toContain("15:20");
  });

  it("a holiday is told apart from a plain day off: «Баярын өдөр ажилласан»", async () => {
    const w = await k.world();
    const admin = (await signIn(h, w.admin)).accessToken;
    const holiday = await k.post(admin, "/v1/holidays", {
      name: "Баярын өдөр",
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      repeatsYearly: false,
      confirmRecompute: true,
    });
    expect(holiday.status).toBe(201);
    k.setClock("11:00");
    await k.send(await k.emp(w), [k.ev(w)]);
    k.setClock("14:30");
    await k.send(await k.emp(w), [k.ev(w, { type: "EXIT" })]);
    k.setClock("16:00");
    await k.tick(w.tenant.id);
    const token = (await signIn(h, w.hr)).accessToken;
    const from = `from=${WORK_DATE}&to=${WORK_DATE}`;
    const list = await k.get(token, `/v1/attendance/off-day-work?${from}`);
    expect(list.body.items[0]).toMatchObject({ employeeId: w.employee.id, offDayKind: "HOLIDAY" });
    const csv = await h
      .http()
      .get(`/v1/exports/off-day-work?format=csv&${from}`)
      .set({ Authorization: `Bearer ${token}` });
    expect(csv.text).toContain("Баярын өдөр ажилласан");
    expect(csv.text).not.toContain("Амралтын өдөр ажилласан");
    const day = (await k.get(token, `/v1/attendance/daily?date=${WORK_DATE}&status=WORKED_OFF_DAY`))
      .body;
    expect(day.items[0]).toMatchObject({ offDayKind: "HOLIDAY", status: "WORKED_OFF_DAY" });
  });
});
