import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asTenant, connectOwner, createFixture, hasDb, type Fixture } from "./helpers";

describe.skipIf(!hasDb)("tenant isolation via Row-Level Security (PRD 24.3)", () => {
  let client: Client;
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    client = await connectOwner();
    a = await createFixture(client);
    b = await createFixture(client);
  });
  afterAll(async () => {
    await client.end();
  });

  it("a tenant reads only its own employees", async () => {
    const rows = await asTenant(
      client,
      a.tenantId,
      async () => (await client.query("SELECT id, tenant_id FROM employee")).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(a.tenantId);
  });

  it("without a tenant in the transaction nothing is visible (fails closed)", async () => {
    const rows = await asTenant(
      client,
      null,
      async () => (await client.query("SELECT id FROM employee")).rows,
    );
    expect(rows).toEqual([]);
  });

  it("cannot insert a row for another tenant", async () => {
    await expect(
      asTenant(client, a.tenantId, () =>
        client.query("INSERT INTO department (tenant_id, name) VALUES ($1, 'Intruder')", [
          b.tenantId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update or delete another tenant's rows (they are invisible)", async () => {
    const result = await asTenant(client, a.tenantId, async () => {
      const upd = await client.query("UPDATE employee SET full_name = 'x' WHERE id = $1", [
        b.employeeId,
      ]);
      const del = await client.query("DELETE FROM employee WHERE id = $1", [b.employeeId]);
      return { updated: upd.rowCount, deleted: del.rowCount };
    });
    expect(result).toEqual({ updated: 0, deleted: 0 });
  });

  it("composite foreign keys reject cross-tenant references", async () => {
    await expect(
      client.query(
        `INSERT INTO employee (tenant_id, employee_no, full_name, department_id, primary_location_id)
         VALUES ($1, 'E-002', 'Cross', $2, $3)`,
        [a.tenantId, b.departmentId, a.locationId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a tenant sees only itself in the tenant table", async () => {
    const rows = await asTenant(
      client,
      a.tenantId,
      async () => (await client.query("SELECT id FROM tenant")).rows,
    );
    expect(rows).toEqual([{ id: a.tenantId }]);
  });

  it("platform_admin can see every tenant", async () => {
    const rows = await asTenant(
      client,
      null,
      async () =>
        (await client.query("SELECT id FROM tenant WHERE id = ANY($1)", [[a.tenantId, b.tenantId]]))
          .rows,
      "platform_admin",
    );
    expect(rows).toHaveLength(2);
  });

  it("resolve_tenant_by_code works without a tenant context and hides suspended tenants", async () => {
    const code = `login-${Date.now()}`;
    const created = await client.query<{ id: string }>(
      "INSERT INTO tenant (code, name) VALUES ($1, 'Login Org') RETURNING id",
      [code],
    );
    const found = await asTenant(
      client,
      null,
      async () =>
        (await client.query("SELECT resolve_tenant_by_code($1) AS id", [code.toUpperCase()]))
          .rows[0].id,
    );
    expect(found).toBe(created.rows[0]!.id);

    await client.query("UPDATE tenant SET status = 'SUSPENDED' WHERE id = $1", [
      created.rows[0]!.id,
    ]);
    const hidden = await asTenant(
      client,
      null,
      async () =>
        (await client.query("SELECT resolve_tenant_by_code($1) AS id", [code])).rows[0].id,
    );
    expect(hidden).toBeNull();
  });

  it("audit_log rows are append-only for the runtime role", async () => {
    await asTenant(client, a.tenantId, async () => {
      await client.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'test.created')", [
        a.tenantId,
      ]);
      await client.query("SAVEPOINT s");
      await expect(client.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(
        /permission denied/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(client.query("DELETE FROM audit_log")).rejects.toThrow(/permission denied/i);
    });
  });
});
