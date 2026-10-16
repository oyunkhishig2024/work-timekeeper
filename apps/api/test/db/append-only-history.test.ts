import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "./helpers";

// Migration 0038: the application role cannot rewrite or erase attendance history.
describe.skipIf(!hasDb)("append-only attendance history (migration 0038)", () => {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  const can = async (privilege: string, table: string) =>
    (
      await client.query<{ ok: boolean }>("SELECT has_table_privilege('app_user', $1, $2) AS ok", [
        table,
        privilege,
      ])
    ).rows[0]!.ok;
  const canColumn = async (table: string, column: string) =>
    (
      await client.query<{ ok: boolean }>(
        "SELECT has_column_privilege('app_user', $1, $2, 'UPDATE') AS ok",
        [table, column],
      )
    ).rows[0]!.ok;

  it("cannot delete events, corrections or the status log", async () => {
    for (const t of ["device_event", "attendance_correction", "attendance_result_log"])
      expect(await can("DELETE", t), t).toBe(false);
  });

  it("cannot update the status log at all", async () => {
    expect(await can("UPDATE", "attendance_result_log")).toBe(false);
    expect(await canColumn("attendance_result_log", "new_status")).toBe(false);
  });

  it("can update only the review and erasure columns of an event", async () => {
    for (const c of ["review_status", "counted", "lat", "coordinates_erased_at"])
      expect(await canColumn("device_event", c), c).toBe(true);
    for (const c of ["occurred_at", "received_at", "employee_id", "type", "flags"])
      expect(await canColumn("device_event", c), c).toBe(false);
  });

  it("can update only the revoke and note columns of a correction", async () => {
    for (const c of ["revoked_at", "revoked_by", "revoke_note", "note"])
      expect(await canColumn("attendance_correction", c), c).toBe(true);
    for (const c of ["status", "arrival_at", "original_status", "created_by"])
      expect(await canColumn("attendance_correction", c), c).toBe(false);
  });

  it("still lets recompute rewrite the derived daily result", async () => {
    expect(await can("DELETE", "attendance_result")).toBe(true);
    expect(await can("UPDATE", "attendance_result")).toBe(true);
  });
});
