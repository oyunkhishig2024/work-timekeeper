import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { at, attendanceKit, WORK_DATE } from "./attendance-kit";
import { auditActions, createUser, type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("personal hours and several places (PRD 14.3)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const hrToken = async (w: Awaited<ReturnType<typeof k.world>>) =>
    (await signIn(h, w.hr)).accessToken;
  const second = async (w: Awaited<ReturnType<typeof k.world>>) =>
    (
      await h.owner.query<{ id: string }>(
        "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Салбар 2', 47.95, 106.95, 150) RETURNING id",
        [w.tenant.id],
      )
    ).rows[0]!.id;
  const row = async (w: Awaited<ReturnType<typeof k.world>>, employeeId: string) => {
    const list = (await k.get(await hrToken(w), `/v1/attendance/daily?date=${WORK_DATE}`)).body;
    return (list.items as Array<Record<string, unknown>>).find((r) => r.employeeId === employeeId)!;
  };
  const body = (w: Awaited<ReturnType<typeof k.world>>, over: object = {}) => ({
    employeeIds: [w.employee.id],
    fromDate: WORK_DATE,
    toDate: WORK_DATE,
    startTime: "06:30",
    endTime: "14:00",
    locationIds: [] as string[],
    ...over,
  });

  it("replaces the day's hours: arriving before 06:30 is on time, and the day ends at 14:00, not 17:00", async () => {
    const w = await k.world();
    const res = await k.post(
      await hrToken(w),
      "/v1/personal-hours",
      body(w, { note: "Эрт ирээрэй" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    k.setClock("06:10");
    await k.send(await k.emp(w), [k.ev(w)]);
    k.setClock("13:59");
    await k.tick(w.tenant.id);
    expect(await row(w, w.employee.id)).toMatchObject({ status: "ON_TIME" });
    // the colleague without personal hours is still pending at 13:59 and a no-show only after 17:00
    expect(await row(w, w.second.employee.id)).toMatchObject({ status: "PENDING" });
    expect((await k.resultOf(w.tenant.id, w.employee.id)).late_minutes).toBe(0);
    expect(await auditActions(h, w.tenant.id)).toContain("personal_hours.created");
  });

  it("someone with personal hours who never comes is a no-show at their own end of day", async () => {
    const w = await k.world();
    await k.post(await hrToken(w), "/v1/personal-hours", body(w));
    k.setClock("13:59");
    await k.tick(w.tenant.id);
    expect(await row(w, w.employee.id)).toMatchObject({ status: "PENDING" });
    k.setClock("14:00");
    await k.tick(w.tenant.id);
    expect(await row(w, w.employee.id)).toMatchObject({ status: "NO_SHOW" });
    expect(await row(w, w.second.employee.id)).toMatchObject({ status: "PENDING" });
  });

  it("several places count as one day: arrival at the second place, then the first, departure from the last", async () => {
    const w = await k.world();
    const other = await second(w);
    const res = await k.post(
      await hrToken(w),
      "/v1/personal-hours",
      body(w, { locationIds: [other, w.locationId] }),
    );
    expect(res.status).toBe(201);
    k.setClock("06:35");
    await k.send(await k.emp(w), [k.ev(w, { locationId: other })]);
    k.setClock("10:10");
    await k.send(await k.emp(w), [k.ev(w, { locationId: other, type: "EXIT" })]);
    k.setClock("10:40");
    await k.send(await k.emp(w), [k.ev(w)]);
    k.setClock("11:00");
    await k.tick(w.tenant.id);
    expect(await row(w, w.employee.id)).toMatchObject({
      status: "ON_TIME",
      locationName: "Салбар 2",
      departureState: "INSIDE",
    });
    k.setClock("14:05");
    await k.send(await k.emp(w), [k.ev(w, { type: "EXIT" })]);
    const left = await row(w, w.employee.id);
    expect(left).toMatchObject({ status: "ON_TIME", departureState: "LEFT" });
    expect(new Date(left.departureAt as string).toISOString()).toBe(at("14:05").toISOString());
  });

  it("deleting them restores the usual hours and the day is rebuilt", async () => {
    const w = await k.world();
    const token = await hrToken(w);
    const created = await k.post(token, "/v1/personal-hours", body(w));
    const id = created.body.personalHoursIds[0] as string;
    k.setClock("14:30");
    await k.tick(w.tenant.id);
    expect(await row(w, w.employee.id)).toMatchObject({ status: "NO_SHOW" });
    const fresh = await hrToken(w);
    const del = await h
      .http()
      .delete(`/v1/personal-hours/${id}`)
      .set({ Authorization: `Bearer ${fresh}` });
    expect(del.status).toBe(204);
    expect(await row(w, w.employee.id)).toMatchObject({ status: "PENDING" }); // 17:00 again
    expect(await auditActions(h, w.tenant.id)).toContain("personal_hours.deleted");
  });

  it("validates, refuses overlaps, and is HR work (Managers read inside their scope)", async () => {
    const w = await k.world();
    const token = await hrToken(w);
    const post = (o: object) => k.post(token, "/v1/personal-hours", body(w, o));
    expect((await post({ endTime: "06:30" })).status).toBe(400);
    expect((await post({ startTime: "6:30" })).status).toBe(400);
    expect((await post({ toDate: "2026-09-01" })).status).toBe(400);
    expect((await post({ fromDate: "2026-01-01", toDate: "2026-01-02" })).status).toBe(400); // too far back
    expect((await post({ locationIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(
      400,
    );
    expect((await post({ employeeIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(
      404,
    );
    expect((await post({})).status).toBe(201);
    const clash = await post({});
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("PERSONAL_HOURS_OVERLAP");
    const mgr = (
      await signIn(h, await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" }))
    ).accessToken;
    expect((await k.post(mgr, "/v1/personal-hours", body(w))).status).toBe(403);
    const listed = await k.get(token, `/v1/personal-hours?employeeId=${w.employee.id}`);
    expect(listed.body.items[0]).toMatchObject({
      startTime: "06:30",
      endTime: "14:00",
      locations: [],
    });
    expect((await k.get(mgr, "/v1/personal-hours")).body.total).toBe(0); // no scope assigned yet
  });
});
