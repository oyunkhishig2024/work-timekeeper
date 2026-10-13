import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit } from "./attendance-kit";
import { type Harness, startHarness } from "./harness";

describe.skipIf(!hasDb)("retention deletes (PRD 15.3, 15.1)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it("refuses a cutoff inside the minimum retention, however it is asked", async () => {
    await k.world(); // the purge runs per organization, so one has to exist
    await expect(k.engine().purgeExpired({ attendance: 5, audit: 730 })).rejects.toThrow(
      /30 days/u,
    );
    await expect(k.engine().purgeExpired({ attendance: 730, audit: 100 })).rejects.toThrow(
      /365 days/u,
    );
  });

  it("deletes attendance data and audit rows past their retention and keeps the rest", async () => {
    const w = await k.world();
    k.setClock("07:00");
    await k.send(await k.emp(w), [k.ev(w, { type: "ENTER" })]);
    k.setClock("17:00");
    await k.tick(w.tenant.id);
    // A second, old duty day: an event, a daily result and a status log row three years ago.
    await h.owner.query(
      `INSERT INTO attendance_result (tenant_id, employee_id, work_date, status, computed_at)
       VALUES ($1, $2, DATE '2023-01-10', 'ON_TIME', now())`,
      [w.tenant.id, w.employee.id],
    );
    await h.owner.query(
      `INSERT INTO attendance_result_log (tenant_id, employee_id, work_date, new_status, changed_at)
       VALUES ($1, $2, DATE '2023-01-10', 'ON_TIME', now())`,
      [w.tenant.id, w.employee.id],
    );
    await h.owner.query(
      `INSERT INTO device_event (tenant_id, employee_id, device_id, location_id, client_event_id, type, occurred_at, received_at)
       SELECT tenant_id, employee_id, device_id, location_id, 'old-event-0001', 'ENTER',
              TIMESTAMPTZ '2023-01-10 07:00+00', TIMESTAMPTZ '2023-01-10 07:00+00'
         FROM device_event WHERE employee_id = $1 LIMIT 1`,
      [w.employee.id],
    );
    await h.owner.query(
      `INSERT INTO audit_log (tenant_id, occurred_at, action) VALUES ($1, TIMESTAMPTZ '2023-01-10 07:00+00', 'old.action')`,
      [w.tenant.id],
    );
    const before = await h.owner.query(
      "SELECT count(*)::int AS n FROM device_event WHERE employee_id = $1",
      [w.employee.id],
    );

    const gone = await k.engine().purgeExpired({ attendance: 730, audit: 730 });
    expect(gone.attendance.deviceEvents).toBeGreaterThanOrEqual(1);
    expect(gone.attendance.results).toBeGreaterThanOrEqual(1);
    expect(gone.attendance.resultLog).toBeGreaterThanOrEqual(1);
    expect(gone.audit).toBeGreaterThanOrEqual(1);

    const after = await h.owner.query(
      "SELECT count(*)::int AS n FROM device_event WHERE employee_id = $1",
      [w.employee.id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n - 1);
    expect(
      (
        await h.owner.query(
          "SELECT count(*)::int AS n FROM attendance_result WHERE employee_id = $1 AND work_date < DATE '2024-01-01'",
          [w.employee.id],
        )
      ).rows[0].n,
    ).toBe(0);
    // The recent day is untouched.
    expect(await k.resultOf(w.tenant.id, w.employee.id)).toBeTruthy();
    expect(
      (await h.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'old.action'"))
        .rows[0].n,
    ).toBe(0);
    // Repeating finds nothing more.
    const again = await k.engine().purgeExpired({ attendance: 730, audit: 730 });
    expect(again.attendance.deviceEvents).toBe(0);
    expect(again.audit).toBe(0);
  });
});
