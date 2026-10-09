import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { connectOwner, createFixture, hasDb, type Fixture } from "./helpers";

describe.skipIf(!hasDb)("data constraints", () => {
  let client: Client;
  let f: Fixture;

  beforeAll(async () => {
    client = await connectOwner();
    f = await createFixture(client);
  });
  afterAll(async () => {
    await client.end();
  });

  it.each([99, 501])("rejects a geofence radius of %i m (PRD 13: 100–500)", async (radius) => {
    await expect(
      client.query(
        "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, $2, 47.9, 106.9, $3)",
        [f.tenantId, `r-${radius}`, radius],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it.each([100, 500])("accepts a geofence radius of %i m", async (radius) => {
    await client.query(
      "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, $2, 47.9, 106.9, $3)",
      [f.tenantId, `ok-${radius}`, radius],
    );
  });

  it("rejects invalid coordinates", async () => {
    await expect(
      client.query(
        "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'bad', 91, 0, 100)",
        [f.tenantId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("enforces unique employee numbers per tenant", async () => {
    await expect(
      client.query(
        `INSERT INTO employee (tenant_id, employee_no, full_name, department_id, primary_location_id)
         VALUES ($1, 'E-001', 'Duplicate', $2, $3)`,
        [f.tenantId, f.departmentId, f.locationId],
      ),
    ).rejects.toThrow(/unique/i);
  });

  it("blocks overlapping temporary location assignments but allows adjacent ones (PRD 12.1)", async () => {
    const insert = (from: string, to: string) =>
      client.query(
        `INSERT INTO temp_location_assignment (tenant_id, employee_id, location_id, from_date, to_date)
         VALUES ($1, $2, $3, $4, $5)`,
        [f.tenantId, f.employeeId, f.locationId, from, to],
      );
    await insert("2026-10-06", "2026-10-08");
    await expect(insert("2026-10-08", "2026-10-10")).rejects.toThrow(/conflicting key|exclusion/i);
    await insert("2026-10-09", "2026-10-10");
  });

  it("rejects a temporary assignment whose end is before its start", async () => {
    await expect(
      client.query(
        `INSERT INTO temp_location_assignment (tenant_id, employee_id, location_id, from_date, to_date)
         VALUES ($1, $2, $3, '2026-11-10', '2026-11-01')`,
        [f.tenantId, f.employeeId, f.locationId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("requires EMPLOYEE accounts to be linked to an employee; staff accounts may be (PRD 4), one login per employee", async () => {
    await expect(
      client.query(
        "INSERT INTO user_account (tenant_id, username, password_hash, role) VALUES ($1, 'e1', 'x', 'EMPLOYEE')",
        [f.tenantId],
      ),
    ).rejects.toThrow(/check constraint/i);
    // an HR account with the person's own employee record is allowed ...
    await client.query(
      "INSERT INTO user_account (tenant_id, username, password_hash, role, employee_id) VALUES ($1, 'h1', 'x', 'HR', $2)",
      [f.tenantId, f.employeeId],
    );
    // ... but never a second login for the same employee
    await expect(
      client.query(
        "INSERT INTO user_account (tenant_id, username, password_hash, role, employee_id) VALUES ($1, 'h2', 'x', 'MANAGER', $2)",
        [f.tenantId, f.employeeId],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("usernames are unique per tenant, case-insensitively", async () => {
    await client.query(
      "INSERT INTO user_account (tenant_id, username, password_hash, role) VALUES ($1, 'Ganbat', 'x', 'HR')",
      [f.tenantId],
    );
    await expect(
      client.query(
        "INSERT INTO user_account (tenant_id, username, password_hash, role) VALUES ($1, 'ganbat', 'x', 'HR')",
        [f.tenantId],
      ),
    ).rejects.toThrow(/unique/i);
  });

  it("a scope row needs a location or a department", async () => {
    const u = await client.query<{ id: string }>(
      "INSERT INTO user_account (tenant_id, username, password_hash, role) VALUES ($1, 'mgr', 'x', 'MANAGER') RETURNING id",
      [f.tenantId],
    );
    await expect(
      client.query("INSERT INTO user_scope (tenant_id, user_id) VALUES ($1, $2)", [
        f.tenantId,
        u.rows[0]!.id,
      ]),
    ).rejects.toThrow(/check constraint/i);
    await client.query(
      "INSERT INTO user_scope (tenant_id, user_id, location_id) VALUES ($1, $2, $3)",
      [f.tenantId, u.rows[0]!.id, f.locationId],
    );
  });
});
