import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit, WORK_DATE } from "./attendance-kit";
import { type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("the phone's geofence plan (Architecture 7.3)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it("lists today and the next two days with the places and the hours, from getExpectation", async () => {
    const w = await k.world();
    k.setClock("07:30");
    const res = await k.get(await k.emp(w), "/v1/mobile/plan");
    expect(res.status).toBe(200);
    expect(res.body.days.map((d: { date: string }) => d.date)).toEqual([
      WORK_DATE,
      "2026-10-07",
      "2026-10-08",
    ]);
    const today = res.body.days[0];
    expect(today).toMatchObject({ expected: true });
    expect(today.locations).toEqual([
      expect.objectContaining({ id: w.locationId, name: "Төв салбар", main: true, radiusM: 150 }),
    ]);
    expect(new Date(today.start).toISOString()).toBe("2026-10-06T00:00:00.000Z"); // 08:00 local
    expect(res.body.places).toHaveLength(1);
    expect(res.body.places[0]).toMatchObject({ lat: 47.9, lng: 106.9 });
  });

  it("follows personal hours with several places, and says nothing is expected on a day off", async () => {
    const w = await k.world();
    const other = (
      await h.owner.query<{ id: string }>(
        "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Салбар 2', 47.95, 106.95, 200) RETURNING id",
        [w.tenant.id],
      )
    ).rows[0]!.id;
    const hr = (await signIn(h, w.hr)).accessToken;
    expect(
      (
        await k.post(hr, "/v1/personal-hours", {
          employeeIds: [w.employee.id],
          fromDate: WORK_DATE,
          toDate: WORK_DATE,
          startTime: "06:30",
          endTime: "14:00",
          locationIds: [other, w.locationId],
        })
      ).status,
    ).toBe(201);
    const admin = (await signIn(h, w.admin)).accessToken;
    expect(
      (await k.post(admin, "/v1/working-day-exceptions", { date: "2026-10-07", working: false }))
        .status,
    ).toBe(201);
    k.setClock("07:30");
    const res = await k.get(await k.emp(w), "/v1/mobile/plan");
    const [today, tomorrow] = res.body.days;
    expect(today.locations.map((l: { id: string; main: boolean }) => [l.id, l.main])).toEqual([
      [other, true],
      [w.locationId, false],
    ]);
    expect(tomorrow).toEqual({ date: "2026-10-07", expected: false, reason: "OFF_DAY" });
    expect(res.body.places).toHaveLength(2);
  });

  it("only an account linked to an employee has a plan", async () => {
    const w = await k.world();
    const hr = (await signIn(h, w.hr)).accessToken;
    const res = await k.get(hr, "/v1/mobile/plan");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMPLOYEE_ONLY");
  });
});
