import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asTenant, connectOwner, createFixture, hasDb, type Fixture } from "./helpers";

const UNIQUE = "23505";
const FK = "23503";
const CHECK = "23514";
const EXCLUSION = "23P01";

describe.skipIf(!hasDb)("rank and position history (PRD 12, 22.1)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectOwner();
  });
  afterAll(async () => {
    await client.end();
  });

  async function ids(f: Fixture) {
    const rank = await client.query<{ id: string }>(
      "INSERT INTO job_rank (tenant_id, name, sort_order) VALUES ($1, 'Ахлагч', 1), ($1, 'Ахлах ахлагч', 2) RETURNING id",
      [f.tenantId],
    );
    const pos = await client.query<{ id: string }>(
      "INSERT INTO job_position (tenant_id, name) VALUES ($1, 'Харуул'), ($1, 'Ахлах харуул') RETURNING id",
      [f.tenantId],
    );
    return { r: rank.rows.map((x) => x.id), p: pos.rows.map((x) => x.id) };
  }
  const rankRow = (f: Fixture, rank: string, from: string, to: string | null) =>
    client.query(
      "INSERT INTO employee_rank_assignment (tenant_id, employee_id, job_rank_id, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5)",
      [f.tenantId, f.employeeId, rank, from, to],
    );
  const posRow = (f: Fixture, pos: string, from: string, to: string | null) =>
    client.query(
      "INSERT INTO employee_position_assignment (tenant_id, employee_id, job_position_id, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5)",
      [f.tenantId, f.employeeId, pos, from, to],
    );

  it("keeps rank and position histories independent of each other", async () => {
    const f = await createFixture(client);
    const { r, p } = await ids(f);
    // Promoted on 2026-06-01; position unchanged since hire.
    await rankRow(f, r[0]!, "2025-01-01", "2026-06-01");
    await rankRow(f, r[1]!, "2026-06-01", null);
    await posRow(f, p[0]!, "2025-01-01", null);
    const at = await client.query(
      `SELECT (SELECT jr.name FROM employee_rank_assignment a JOIN job_rank jr ON jr.id = a.job_rank_id
                WHERE a.employee_id = $1 AND a.valid_from <= $2 AND (a.valid_to IS NULL OR a.valid_to > $2)) AS rank,
              (SELECT jp.name FROM employee_position_assignment a JOIN job_position jp ON jp.id = a.job_position_id
                WHERE a.employee_id = $1 AND a.valid_from <= $2 AND (a.valid_to IS NULL OR a.valid_to > $2)) AS position`,
      [f.employeeId, "2026-03-01"],
    );
    expect(at.rows[0]).toEqual({ rank: "Ахлагч", position: "Харуул" });
    const now = await client.query(
      "SELECT jr.name FROM employee_rank_assignment a JOIN job_rank jr ON jr.id = a.job_rank_id WHERE a.employee_id = $1 AND a.valid_to IS NULL",
      [f.employeeId],
    );
    expect(now.rows[0]!.name).toBe("Ахлах ахлагч");
  });

  it("rejects overlapping periods and invalid ranges", async () => {
    const f = await createFixture(client);
    const { r, p } = await ids(f);
    await rankRow(f, r[0]!, "2026-01-01", "2026-06-01");
    await expect(rankRow(f, r[1]!, "2026-05-31", null)).rejects.toMatchObject({ code: EXCLUSION });
    await expect(rankRow(f, r[1]!, "2026-07-01", "2026-07-01")).rejects.toMatchObject({
      code: CHECK,
    });
    await posRow(f, p[0]!, "2026-01-01", null);
    await expect(posRow(f, p[1]!, "2026-02-01", null)).rejects.toMatchObject({ code: EXCLUSION });
  });

  it("allows back-to-back periods (half-open ranges)", async () => {
    const f = await createFixture(client);
    const { p } = await ids(f);
    await posRow(f, p[0]!, "2026-01-01", "2026-03-01");
    await expect(posRow(f, p[1]!, "2026-03-01", null)).resolves.toBeDefined();
  });

  it("keeps unique names and sort order per tenant, and ranks cannot cross tenants", async () => {
    const a = await createFixture(client);
    const b = await createFixture(client);
    const ra = await ids(a);
    await ids(b); // same names in another tenant are fine
    await expect(
      client.query("INSERT INTO job_rank (tenant_id, name, sort_order) VALUES ($1, 'Ахмад', 1)", [
        a.tenantId,
      ]),
    ).rejects.toMatchObject({ code: UNIQUE });
    await expect(
      client.query("INSERT INTO job_position (tenant_id, name) VALUES ($1, 'Харуул')", [
        a.tenantId,
      ]),
    ).rejects.toMatchObject({ code: UNIQUE });
    // tenant B's employee cannot take tenant A's rank
    await expect(rankRow(b, ra.r[0]!, "2026-01-01", null)).rejects.toMatchObject({ code: FK });
  });

  it("is isolated by tenant (RLS)", async () => {
    const a = await createFixture(client);
    const b = await createFixture(client);
    await ids(a);
    const visible = await asTenant(client, b.tenantId, async () => {
      const res = await client.query("SELECT count(*)::int AS n FROM job_rank");
      return res.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});
