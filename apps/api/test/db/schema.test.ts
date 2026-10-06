import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { connectOwner, hasDb } from "./helpers";

describe.skipIf(!hasDb)("schema invariants (Architecture 5.2)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectOwner();
  });
  afterAll(async () => {
    await client.end();
  });

  it("every table with a tenant_id has RLS enabled, forced and at least one policy", async () => {
    const { rows } = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY c.relname`);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const offenders = rows.filter(
      (r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies < 1,
    );
    expect(offenders).toEqual([]);
  });

  it("every other table (except the migrations table) also has RLS enabled", async () => {
    const { rows } = await client.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'pgmigrations'
        AND NOT c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it("runtime roles cannot bypass RLS", async () => {
    const { rows } = await client.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      "SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('app_user','platform_admin')",
    );
    expect(rows).toHaveLength(2);
    for (const role of rows) {
      expect(role.rolbypassrls).toBe(false);
      expect(role.rolcanlogin).toBe(false);
    }
  });

  it.each([
    ["platform_user", "SELECT"],
    ["tenant", "INSERT"],
    ["tenant", "UPDATE"],
    ["audit_log", "UPDATE"],
    ["audit_log", "DELETE"],
  ])("app_user has no %s privilege on %s", async (table, privilege) => {
    const { rows } = await client.query<{ ok: boolean }>(
      "SELECT has_table_privilege('app_user', $1, $2) AS ok",
      [table, privilege],
    );
    expect(rows[0]!.ok).toBe(false);
  });
});
