import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { at, attendanceKit, WORK_DATE, type W } from "./attendance-kit";
import { createEmployee, createUser, type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("daily attendance list (PRD 9, 6.5, 11)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const hr = (w: W) => signIn(h, w.hr).then((t) => t.accessToken);
  const list = async (w: W, query = "") =>
    (await k.get(await hr(w), `/v1/attendance/daily?date=${WORK_DATE}${query}`)).body;

  it("shows the expected branch with a temporary flag when it differs from the primary one", async () => {
    const w = await k.world();
    const other = (
      await h.owner.query<{ id: string }>(
        "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'ЭМАА', 47.9, 106.9, 150) RETURNING id",
        [w.tenant.id],
      )
    ).rows[0]!.id;
    await h.owner.query(
      "INSERT INTO temp_location_assignment (tenant_id, employee_id, location_id, from_date, to_date) VALUES ($1, $2, $3, $4, $4)",
      [w.tenant.id, w.second.employee.id, other, WORK_DATE],
    );
    k.setClock("08:30");
    await k.tick(w.tenant.id);
    const rows = (await list(w)).items as Array<Record<string, unknown>>;
    const mine = rows.find((r) => r.employeeId === w.employee.id)!;
    const temp = rows.find((r) => r.employeeId === w.second.employee.id)!;
    expect(mine).toMatchObject({
      locationName: "Төв салбар",
      primaryLocationName: "Төв салбар",
      temporary: false,
    });
    expect(temp).toMatchObject({
      locationName: "ЭМАА",
      primaryLocationName: "Төв салбар",
      temporary: true,
    });
  });

  it("searches by name or code, within the filters, and counts every status for the chips", async () => {
    const w = await k.world();
    const extra = await createEmployee(h, w.tenant);
    await h.owner.query(
      "UPDATE employee SET last_name = 'Ганбат', first_name = 'Төгөлдөр' WHERE id = $1",
      [extra.id],
    );
    k.setClock("08:05");
    await k.send(await k.emp(w), [k.ev(w)]);
    k.setClock("10:30");
    await k.tick(w.tenant.id);

    const byName = await list(w, "&q=" + encodeURIComponent("төгөл"));
    expect(byName.items.map((r: { employeeId: string }) => r.employeeId)).toEqual([extra.id]);
    const code = (
      await h.owner.query<{ employee_no: string }>(
        "SELECT employee_no FROM employee WHERE id = $1",
        [w.employee.id],
      )
    ).rows[0]!.employee_no;
    expect((await list(w, `&q=${code}`)).items).toHaveLength(1);
    expect((await list(w, "&q=%25")).items).toHaveLength(0); // a wildcard is searched for literally

    const all = await list(w);
    // the second employee's phone has never been heard from, so that no-show is also «inactive»; the employee without a phone is not
    expect(all.counts).toMatchObject({ EXPECTED: 3, ON_TIME: 1, NO_SHOW: 2, LATE: 0, INACTIVE: 1 });
    // the chips' counts ignore the status filter but follow the other filters
    const filtered = await list(w, "&status=NO_SHOW&q=" + encodeURIComponent("төгөл"));
    expect(filtered.total).toBe(1);
    expect(filtered.counts).toMatchObject({ EXPECTED: 1, NO_SHOW: 1, ON_TIME: 0 });
  });

  it("flags «Байршил идэвхгүй»: no arrival and a silent phone for over an hour; a heartbeat clears it", async () => {
    const w = await k.world();
    k.setClock("08:00");
    await k.tick(w.tenant.id);
    k.setClock("09:30");
    await k.tick(w.tenant.id);
    // Neither phone has reported since registration.
    const day = await list(w);
    expect(day.counts.INACTIVE).toBe(2);
    expect(day.items.every((r: { locationInactive: boolean }) => r.locationInactive)).toBe(true);
    const inactive = await list(w, "&status=INACTIVE");
    expect(inactive.total).toBe(2);
    expect(inactive.items[0]).toMatchObject({ status: "PENDING", hasDevice: true });
    expect(inactive.items[0].lastSeenAt).toBeNull(); // never heard from since registration

    // One phone reports in (a heartbeat counts as being heard from).
    expect((await k.post(await k.emp(w), "/v1/heartbeat")).status).toBe(200);
    const after = await list(w, "&status=INACTIVE");
    expect(after.items.map((r: { employeeId: string }) => r.employeeId)).toEqual([
      w.second.employee.id,
    ]);
    expect(after.counts.INACTIVE).toBe(1);
  });

  it("an employee without a device is not «inactive» (manual attendance), and an arrived one never is", async () => {
    const w = await k.world();
    const manual = await createEmployee(h, w.tenant);
    k.setClock("08:05");
    await k.send(await k.emp(w), [k.ev(w)]);
    k.setClock("09:45");
    await k.tick(w.tenant.id);
    const inactive = await list(w, "&status=INACTIVE");
    expect(inactive.items.map((r: { employeeId: string }) => r.employeeId)).toEqual([
      w.second.employee.id,
    ]);
    const all = (await list(w)).items as Array<{
      employeeId: string;
      hasDevice: boolean;
      locationInactive: boolean;
    }>;
    expect(all.find((r) => r.employeeId === manual.id)).toMatchObject({
      hasDevice: false,
      locationInactive: false,
    });
    expect(all.find((r) => r.employeeId === w.employee.id)!.locationInactive).toBe(false);
  });

  it("«Бусад» keeps its explanation next to the excused day, and the row says which assignment covers it", async () => {
    const w = await k.world();
    const token = await hr(w);
    const reasons = (await k.get(token, "/v1/reasons")).body as Array<{ id: string; name: string }>;
    const other = reasons.find((r) => r.name === "Бусад")!;
    const res = await k.post(token, "/v1/reason-assignments", {
      employeeIds: [w.employee.id],
      reasonId: other.id,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      description: "Хурлын өрөөнд ажилласан",
    });
    expect(res.status).toBe(201);
    const row = (await list(w)).items.find(
      (r: { employeeId: string }) => r.employeeId === w.employee.id,
    );
    expect(row).toMatchObject({
      status: "EXCUSED",
      reasonName: "Бусад",
      reasonNote: "Хурлын өрөөнд ажилласан",
      reasonAssignmentId: expect.any(String),
    });
  });

  it("assigning a reason updates the day at once (no waiting for the worker); ending it early takes it back", async () => {
    const w = await k.world();
    k.setClock("18:00");
    await k.tick(w.tenant.id);
    expect((await list(w)).counts).toMatchObject({ NO_SHOW: 2, EXCUSED: 0 });
    const token = await hr(w);
    const sick = (
      (await k.get(token, "/v1/reasons")).body as Array<{ id: string; name: string }>
    ).find((r) => r.name === "Өвчтэй")!;
    // Explaining an earlier day (the common case): 3 days from the day before yesterday.
    const res = await k.post(token, "/v1/reason-assignments", {
      employeeIds: [w.employee.id],
      reasonId: sick.id,
      fromDate: "2026-10-04",
      toDate: "2026-10-08",
    });
    expect(res.status).toBe(201);
    const excused = await list(w);
    expect(excused.counts).toMatchObject({ NO_SHOW: 1, EXCUSED: 1 });
    const row = excused.items.find((r: { employeeId: string }) => r.employeeId === w.employee.id);
    expect(row.reasonAssignmentId).toBe(res.body.assignmentIds[0]);
    // Ended on 2026-10-05: the work date 2026-10-06 is no longer covered.
    const end = await k.post(token, `/v1/reason-assignments/${row.reasonAssignmentId}/end`, {
      endDate: "2026-10-05",
    });
    expect(end.status).toBe(200);
    expect((await list(w)).counts).toMatchObject({ NO_SHOW: 2, EXCUSED: 0 });
  });

  it("exports the daily attendance with the same filters (Excel / CSV), audited, in the organization's time", async () => {
    const w = await k.world();
    k.setClock("08:05");
    await k.send(await k.emp(w), [k.ev(w)]);
    k.setClock("10:30");
    await k.tick(w.tenant.id);
    const token = await hr(w);
    const csv = await h
      .http()
      .get(`/v1/exports/daily-attendance?format=csv&date=${WORK_DATE}&status=NO_SHOW`)
      .set({ Authorization: `Bearer ${token}` });
    expect(csv.status).toBe(200);
    const lines = csv.text.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2); // header + the one person who did not come
    expect(lines[0]).toContain("Төлөв");
    expect(lines[1]).toContain("Ирээгүй");
    const all = await h
      .http()
      .get(`/v1/exports/daily-attendance?format=csv&date=${WORK_DATE}`)
      .set({ Authorization: `Bearer ${token}` });
    const onTime = all.text.split("\r\n").find((l) => l.includes("Цагтаа"))!;
    expect(onTime).toContain("08:05"); // Ulaanbaatar time, not UTC
    const audit = await h.owner.query(
      "SELECT after FROM audit_log WHERE tenant_id = $1 AND action = 'report.exported'",
      [w.tenant.id],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    const mgr = (
      await signIn(h, await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" }))
    ).accessToken;
    expect(
      (
        await h
          .http()
          .get(`/v1/exports/daily-attendance?format=csv&date=${WORK_DATE}`)
          .set({ Authorization: `Bearer ${mgr}` })
      ).status,
    ).toBe(403);
    void at;
  });
});
