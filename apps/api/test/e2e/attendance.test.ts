import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit, at, WORK_DATE, type W } from "./attendance-kit";
import {
  createEmployee,
  createEmployeeWithUser,
  createUser,
  type Harness,
  signIn,
  startHarness,
} from "./harness";

describe.skipIf(!hasDb)("attendance core: events, deriveStatus, daily results (PRD 6, 7)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const setClock = (hhmm: string) => k.setClock(hhmm);
  const tick = (tenantId: string) => k.tick(tenantId);
  const get = (token: string, url: string) => k.get(token, url);
  const post = (token: string, url: string, body: object = {}) => k.post(token, url, body);
  const world = () => k.world();
  const emp = (w: W) => k.emp(w);
  const second = (w: W) => k.second(w);
  const ev = (w: W, over: Partial<Record<string, unknown>> = {}) => k.ev(w, over);
  const send = (token: string, events: object[]) => k.send(token, events);
  const resultOf = (tenantId: string, employeeId: string) => k.resultOf(tenantId, employeeId);
  const hrToken = (w: W) => k.hrToken(w);

  it("ENTER is PENDING until the minimum stay passes, then ON_TIME with the first ENTER as arrival (6.4)", async () => {
    const w = await world();
    setClock("08:10");
    const res = await send(await emp(w), [ev(w)]);
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outcome: "ACCEPTED", counted: true, flags: [] });
    expect((await resultOf(w.tenant.id, w.employee.id)).status).toBe("PENDING");

    setClock("08:14");
    await tick(w.tenant.id);
    const row = await resultOf(w.tenant.id, w.employee.id);
    expect(row.status).toBe("ON_TIME");
    expect(row.arrival_at.toISOString()).toBe(at("08:10").toISOString());

    const log = await h.owner.query(
      "SELECT old_status, new_status FROM attendance_result_log WHERE employee_id = $1 AND work_date = $2 ORDER BY changed_at, new_status",
      [w.employee.id, WORK_DATE],
    );
    expect(log.rows.map((r) => `${r.old_status}>${r.new_status}`)).toEqual([
      "null>PENDING",
      "PENDING>ON_TIME",
    ]);
  });

  it("arrival after grace is LATE with minutes since start, even after the cut-off (6.2, 6.3)", async () => {
    const w = await world();
    setClock("10:30");
    await send(await emp(w), [ev(w)]);
    setClock("10:40");
    await tick(w.tenant.id);
    expect(await resultOf(w.tenant.id, w.employee.id)).toMatchObject({
      status: "LATE",
      late_minutes: 150,
    });
  });

  it("arriving hours before the start is on time, with no early-arrival limit (6.2)", async () => {
    const w = await world();
    setClock("05:10");
    await send(await emp(w), [ev(w)]);
    setClock("06:00");
    await tick(w.tenant.id);
    expect(await resultOf(w.tenant.id, w.employee.id)).toMatchObject({
      status: "ON_TIME",
      late_minutes: 0,
    });
  });

  it("a retried upload is accepted once (idempotent client event id, 6.8)", async () => {
    const w = await world();
    setClock("08:05");
    const e = ev(w);
    expect((await send(await emp(w), [e])).body.results[0].outcome).toBe("ACCEPTED");
    expect((await send(await emp(w), [e])).body.results[0].outcome).toBe("DUPLICATE");
    const n = await h.owner.query(
      "SELECT count(*)::int AS n FROM device_event WHERE employee_id = $1",
      [w.employee.id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("an offline event is timed by the server (receive time minus age), not by the phone's clock (6.8)", async () => {
    const w = await world();
    setClock("08:40");
    // Left the queue 30 minutes late; the phone clock is one hour fast.
    const res = await send(await emp(w), [
      ev(w, { ageMs: 30 * 60_000, deviceTime: new Date(at("09:10").getTime()).toISOString() }),
    ]);
    expect(res.body.results[0]).toMatchObject({ outcome: "ACCEPTED", counted: true });
    expect(res.body.results[0].flags).toEqual(["CLOCK_SKEW"]);
    expect(res.body.results[0].occurredAt).toBe(at("08:10").toISOString());
    expect(await resultOf(w.tenant.id, w.employee.id)).toMatchObject({ status: "ON_TIME" });
  });

  it("events older than 24 h and imprecise ENTER fixes are stored and flagged but do not count (6.7, 6.8)", async () => {
    const w = await world();
    setClock("08:10");
    const res = await send(await emp(w), [
      ev(w, { ageMs: 25 * 3_600_000 }),
      ev(w, { accuracyM: 80 }),
      ev(w, { type: "EXIT", accuracyM: 80 }),
    ]);
    expect(res.body.results.map((r: { counted: boolean }) => r.counted)).toEqual([
      false,
      false,
      true,
    ]);
    expect(res.body.results[0].flags).toEqual(["LATE_SYNC"]);
    expect(res.body.results[1].flags).toEqual(["LOW_ACCURACY"]);
    setClock("09:00");
    await tick(w.tenant.id);
    expect((await resultOf(w.tenant.id, w.employee.id)).status).toBe("PENDING");
  });

  it("no arrival stays PENDING all day and becomes NO_SHOW only when the day ends; a reason then makes it EXCUSED (6.3, 6.6)", async () => {
    const w = await world();
    setClock("12:00");
    await tick(w.tenant.id);
    expect((await resultOf(w.tenant.id, w.employee.id)).status).toBe("PENDING");
    setClock("16:59");
    await tick(w.tenant.id);
    expect((await resultOf(w.tenant.id, w.employee.id)).status).toBe("PENDING");
    setClock("17:00");
    await tick(w.tenant.id);
    expect((await resultOf(w.tenant.id, w.employee.id)).status).toBe("NO_SHOW");

    const hr = await hrToken(w);
    const reasons = (await get(hr, "/v1/reasons")).body as Array<{ id: string; name: string }>;
    await post(hr, "/v1/reason-assignments", {
      employeeIds: [w.employee.id],
      reasonId: reasons[0]!.id,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
    });
    // The assignment already rebuilt the day; a recompute afterwards changes nothing (it is idempotent).
    const rc = await post(hr, "/v1/attendance/recompute", { from: WORK_DATE, to: WORK_DATE });
    expect(rc.status).toBe(200);
    expect(rc.body.changed).toBe(0);
    expect(await resultOf(w.tenant.id, w.employee.id)).toMatchObject({
      status: "EXCUSED",
      reason_name: reasons[0]!.name,
    });
  });

  it("daily list and dashboard summary count everyone expected, with one-decimal rates (7, 8)", async () => {
    const w = await world();
    const third = await createEmployee(h, w.tenant);
    await createEmployee(h, w.tenant);
    setClock("08:05");
    await send(await emp(w), [ev(w)]);
    setClock("08:30");
    await send(await second(w), [ev(w)]);
    setClock("17:00");
    await tick(w.tenant.id);
    expect(third.id).toBeTruthy();

    const hr = await hrToken(w);
    const s = await get(hr, `/v1/attendance/summary?date=${WORK_DATE}`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      total: 4,
      onTime: 1,
      late: 1,
      noShow: 2,
      excused: 0,
      pending: 0,
      onTimeRate: 25,
      lateRate: 25,
      noShowRate: 50,
    });
    expect(s.body.byLocation).toHaveLength(1);
    expect(s.body.byLocation[0]).toMatchObject({ total: 4, noShow: 2 });
    expect(s.body.byDepartment[0]).toMatchObject({ total: 4 });

    const list = await get(hr, `/v1/attendance/daily?date=${WORK_DATE}&status=NO_SHOW`);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0]).toMatchObject({ status: "NO_SHOW", locationName: "Төв салбар" });
    expect(list.body.items[0]).toHaveProperty("rank");
    expect(list.body.items[0]).toHaveProperty("position");
  });

  it("EXPECTED lists everyone expected that day (the dashboard's total), including those still pending", async () => {
    const w = await world();
    await createEmployee(h, w.tenant);
    k.setClock("08:05");
    await send(await emp(w), [ev(w)]);
    k.setClock("08:30");
    await tick(w.tenant.id);
    const hr = await hrToken(w);
    const all = await get(hr, `/v1/attendance/daily?date=${WORK_DATE}&status=EXPECTED`);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((i: { status: string }) => i.status).sort()).toEqual([
      "ON_TIME",
      "PENDING",
      "PENDING",
    ]);
    const s = await get(hr, `/v1/attendance/summary?date=${WORK_DATE}`);
    expect(s.body.total).toBe(all.body.total);
    expect((await get(hr, `/v1/attendance/daily?date=${WORK_DATE}&status=BOGUS`)).status).toBe(400);
  });

  it("a Manager sees only their scope; with no scope assigned they see nothing (4)", async () => {
    const w = await world();
    setClock("17:00");
    await tick(w.tenant.id);
    const mgrUser = await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" });
    const mgr = (await signIn(h, mgrUser)).accessToken;
    const s = await get(mgr, `/v1/attendance/summary?date=${WORK_DATE}`);
    expect(s.body.total).toBe(0);
    await h.owner.query(
      "INSERT INTO user_scope (tenant_id, user_id, location_id) VALUES ($1, $2, $3)",
      [w.tenant.id, mgrUser.id, w.locationId],
    );
    expect((await get(mgr, `/v1/attendance/summary?date=${WORK_DATE}`)).body.total).toBe(2);
  });

  it("only the employee's active registered device may report; staff cannot (21.2)", async () => {
    const w = await world();
    setClock("08:10");
    expect((await send(await hrToken(w), [ev(w)])).status).toBe(403);
    // Unregistered session of another employee: no device bound.
    const other = await createEmployeeWithUser(h, w.tenant, "nodevice");
    const tokens = await signIn(h, other.user);
    expect((await send(tokens.accessToken, [ev(w)])).body.code).toBe("DEVICE_REQUIRED");
    // A disabled device ends the session at once (21.2).
    const token = await emp(w);
    await h.owner.query(
      "UPDATE device SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'LOST' WHERE employee_id = $1",
      [w.employee.id],
    );
    expect((await send(token, [ev(w)])).status).toBe(401);
  });

  it("an unknown location is rejected per event without failing the batch", async () => {
    const w = await world();
    setClock("08:10");
    const res = await send(await emp(w), [
      ev(w, { locationId: "00000000-0000-4000-8000-000000000000" }),
      ev(w),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "REJECTED",
      "ACCEPTED",
    ]);
  });

  it("a confirmed stay on a holiday is WORKED_OFF_DAY and is not counted as expected (6.1)", async () => {
    const w = await world();
    const hol = await post(w.adminTokens.accessToken, "/v1/holidays", {
      name: "Баяр",
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      confirmRecompute: true,
    });
    expect(hol.status).toBe(201);
    setClock("09:00");
    await send(await emp(w), [ev(w)]);
    setClock("09:10");
    await tick(w.tenant.id);
    expect((await resultOf(w.tenant.id, w.employee.id)).status).toBe("WORKED_OFF_DAY");
    const s = await get(await hrToken(w), `/v1/attendance/summary?date=${WORK_DATE}`);
    expect(s.body).toMatchObject({ total: 0, workedOffDay: 1 });
  });

  it("the employee reads their own history and heartbeat updates the device (5)", async () => {
    const w = await world();
    setClock("08:05");
    await send(await emp(w), [ev(w)]);
    setClock("08:10");
    await tick(w.tenant.id);
    const mine = await get(await emp(w), `/v1/me/attendance?from=${WORK_DATE}&to=${WORK_DATE}`);
    expect(mine.body.items[0]).toMatchObject({ date: WORK_DATE, status: "ON_TIME" });
    expect((await post(await emp(w), "/v1/heartbeat")).status).toBe(200);
    const seen = await h.owner.query(
      "SELECT last_seen_at FROM device WHERE employee_id = $1 AND status = 'ACTIVE'",
      [w.employee.id],
    );
    expect(seen.rows[0].last_seen_at.toISOString()).toBe(at("08:10").toISOString());
    expect((await get(await emp(w), `/v1/attendance/summary?date=${WORK_DATE}`)).status).toBe(403);
  });
});
