import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { connectOwner, hasDb } from "./helpers";

/**
 * A foreign key whose child columns lead no index makes every delete or change of the parent scan the child table. This guard
 * lists such keys; `created_by`-style audit columns are skipped (nobody is ever deleted, only disabled). Anything else that shows
 * up must be indexed in a migration, or added here with the reason it is harmless.
 */
const ACCEPTED = new Set([
  // small tables that are only read through their parent or whose parents are never deleted
  "attendance_rule_version (tenant_id,location_id) -> location",
  "device (tenant_id,replaced_by_device_id) -> device",
  "holiday_location (tenant_id) -> tenant",
  "holiday_location (tenant_id,holiday_id) -> holiday",
  "holiday_location (tenant_id,location_id) -> location",
  "onboarding_qr_use (tenant_id,device_id) -> device",
  "personal_hours_location (tenant_id) -> tenant",
  "personal_hours_location (tenant_id,location_id) -> location",
  "personal_hours_location (tenant_id,personal_hours_id) -> personal_hours",
  "shift_pattern_day (tenant_id,pattern_id) -> shift_pattern",
  "shift_template (tenant_id,supersedes_id) -> shift_template",
  "temp_location_assignment (tenant_id,location_id) -> location",
  "user_scope (tenant_id,location_id) -> location",
  "working_week_version (tenant_id,location_id) -> location",
  "working_week_day (tenant_id) -> tenant",
  // the primary key (working_week_id, weekday) already serves the lookup by week; week versions are never deleted
  "working_week_day (tenant_id,working_week_id) -> working_week_version",
  "working_day_exception (tenant_id,location_id) -> location",
]);

describe.skipIf(!hasDb)("indexes behind foreign keys", () => {
  let db: Client;
  beforeAll(async () => {
    db = await connectOwner();
  });
  afterAll(async () => {
    await db.end();
  });

  it("every foreign key is backed by an index, or is accepted here with a reason", async () => {
    const { rows } = await db.query<{ fk: string; cols: string[] }>(
      `SELECT c.conrelid::regclass || ' (' || (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) || ') -> ' || c.confrelid::regclass AS fk,
              (SELECT array_agg(a.attname::text) FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) AS cols
         FROM pg_constraint c
        WHERE c.connamespace = 'public'::regnamespace AND c.contype = 'f'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indrelid = c.conrelid
               AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] = c.conkey)`,
    );
    const unexpected = rows
      .filter((r) => !r.cols.some((col) => /_by$/u.test(col)))
      .map((r) => r.fk)
      .filter((fk) => !ACCEPTED.has(fk));
    expect(unexpected).toEqual([]);
  });
});
