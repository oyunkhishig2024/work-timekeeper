import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttendanceService } from "../../src/attendance/attendance.service";
import { hasDb } from "../db/helpers";
import { attendanceKit } from "./attendance-kit";
import { type Harness, startHarness } from "./harness";

/** The worker recomputes everyone every minute (PRD 24): a minute in which nothing changed must write nothing. */
describe.skipIf(!hasDb)("worker tick: no redundant writes", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const rows = async (tenantId: string) =>
    (
      await h.owner.query<{ id: string; xmin: string; status: string }>(
        "SELECT employee_id AS id, xmin::text, status FROM attendance_result WHERE tenant_id = $1 ORDER BY employee_id, work_date",
        [tenantId],
      )
    ).rows;

  it("a tick that changes nothing rewrites no row; a real change is still written", async () => {
    const w = await k.world();
    k.setClock("07:00");
    await k.tick(w.tenant.id);
    k.setClock("09:00");
    await k.tick(w.tenant.id); // both employees are PENDING / waiting for the cutoff
    const before = await rows(w.tenant.id);
    expect(before.length).toBeGreaterThan(0);

    k.setClock("09:01");
    const changed = await k.tick(w.tenant.id);
    expect(changed).toBe(0);
    expect(await rows(w.tenant.id)).toEqual(before); // same row versions: nothing was rewritten

    // time passing past the cutoff is a real change and is written
    k.setClock("18:00");
    await k.tick(w.tenant.id);
    const after = await rows(w.tenant.id);
    expect(after.map((r) => r.status)).not.toEqual(before.map((r) => r.status));
  });

  it("the minute tick covers active organizations only, and a reactivated one is covered again", async () => {
    const w = await k.world();
    const engine = h.app.get(AttendanceService);
    expect(await engine.activeTenantIds()).toContain(w.tenant.id);
    await h.owner.query("UPDATE tenant SET status = 'SUSPENDED' WHERE id = $1", [w.tenant.id]);
    expect(await engine.activeTenantIds()).not.toContain(w.tenant.id);
    await h.owner.query("UPDATE tenant SET status = 'ACTIVE' WHERE id = $1", [w.tenant.id]);
    expect(await engine.activeTenantIds()).toContain(w.tenant.id);
    // and a reactivated organization catches up on its next tick
    await h.owner.query("DELETE FROM attendance_result WHERE tenant_id = $1", [w.tenant.id]);
    k.setClock("09:00");
    await k.tick(w.tenant.id);
    expect((await rows(w.tenant.id)).length).toBeGreaterThan(0);
  });
});
