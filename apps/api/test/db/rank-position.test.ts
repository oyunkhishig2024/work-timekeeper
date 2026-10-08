import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { connectOwner, createFixture, hasDb, type Fixture } from "./helpers";

const CHECK = "23514";
const EXCLUSION = "23P01";
const FK = "23503";

describe.skipIf(!hasDb)("rank and position history, free text (PRD 12, 22.1)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectOwner();
  });
  afterAll(async () => {
    await client.end();
  });

  const rankRow = (f: Fixture, title: string, from: string, to: string | null) =>
    client.query(
      "INSERT INTO employee_rank_assignment (tenant_id, employee_id, title, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5)",
      [f.tenantId, f.employeeId, title, from, to],
    );
  const posRow = (f: Fixture, title: string, from: string, to: string | null) =>
    client.query(
      "INSERT INTO employee_position_assignment (tenant_id, employee_id, title, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5)",
      [f.tenantId, f.employeeId, title, from, to],
    );

  it("keeps rank and position histories independent; any wording is allowed", async () => {
    const f = await createFixture(client);
    await rankRow(f, "Ахлагч", "2025-01-01", "2026-06-01");
    await rankRow(f, "Ахлах мэргэжилтэн", "2026-06-01", null); // not a military rank: free text
    await posRow(f, "Харуул", "2025-01-01", null);
    const at = await client.query(
      `SELECT (SELECT title FROM employee_rank_assignment WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)) AS rank,
              (SELECT title FROM employee_position_assignment WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)) AS position`,
      [f.employeeId, "2026-03-01"],
    );
    expect(at.rows[0]).toEqual({ rank: "Ахлагч", position: "Харуул" });
  });

  it("rejects overlapping periods, blank or over-long titles and invalid ranges", async () => {
    const f = await createFixture(client);
    await rankRow(f, "A", "2026-01-01", "2026-06-01");
    await expect(rankRow(f, "B", "2026-05-31", null)).rejects.toMatchObject({ code: EXCLUSION });
    await expect(rankRow(f, "B", "2026-07-01", "2026-07-01")).rejects.toMatchObject({
      code: CHECK,
    });
    await expect(posRow(f, "   ", "2026-01-01", null)).rejects.toMatchObject({ code: CHECK });
    await expect(posRow(f, "x".repeat(121), "2026-01-01", null)).rejects.toMatchObject({
      code: CHECK,
    });
    await posRow(f, "P", "2026-01-01", "2026-03-01");
    await expect(posRow(f, "Q", "2026-03-01", null)).resolves.toBeDefined(); // back to back
  });

  it("only an employee of the same tenant can have a history", async () => {
    const a = await createFixture(client);
    const b = await createFixture(client);
    await expect(
      client.query(
        "INSERT INTO employee_rank_assignment (tenant_id, employee_id, title, valid_from) VALUES ($1, $2, 'X', '2026-01-01')",
        [b.tenantId, a.employeeId],
      ),
    ).rejects.toMatchObject({ code: FK });
  });

  describe("names (Овог / Нэр)", () => {
    it("full_name and the two parts are kept in step, whichever is written", async () => {
      const f = await createFixture(client); // inserted with full_name only: 'Бадам Гэндэн'
      const row = async () =>
        (
          await client.query(
            "SELECT last_name, first_name, full_name FROM employee WHERE id = $1",
            [f.employeeId],
          )
        ).rows[0];
      expect(await row()).toEqual({
        last_name: "Бадам",
        first_name: "Гэндэн",
        full_name: "Бадам Гэндэн",
      });
      await client.query("UPDATE employee SET first_name = 'Гэндэн-Эрдэнэ' WHERE id = $1", [
        f.employeeId,
      ]);
      expect(await row()).toEqual({
        last_name: "Бадам",
        first_name: "Гэндэн-Эрдэнэ",
        full_name: "Бадам Гэндэн-Эрдэнэ",
      });
      await client.query(
        "UPDATE employee SET last_name = 'Дорж', first_name = 'Бат' WHERE id = $1",
        [f.employeeId],
      );
      expect(await row()).toEqual({ last_name: "Дорж", first_name: "Бат", full_name: "Дорж Бат" });
      // an old-style update of full_name only is split again
      await client.query("UPDATE employee SET full_name = 'Нямаа Сарнай Цэцэг' WHERE id = $1", [
        f.employeeId,
      ]);
      expect(await row()).toEqual({
        last_name: "Нямаа",
        first_name: "Сарнай Цэцэг",
        full_name: "Нямаа Сарнай Цэцэг",
      });
      await client.query("UPDATE employee SET full_name = 'Хулан' WHERE id = $1", [f.employeeId]);
      expect(await row()).toEqual({ last_name: "", first_name: "Хулан", full_name: "Хулан" });
      // new-style insert
      const inserted = await client.query(
        `INSERT INTO employee (tenant_id, employee_no, last_name, first_name, department_id, primary_location_id)
         VALUES ($1, 'N-1', 'Эрдэнэ', 'Болд', $2, $3) RETURNING full_name`,
        [f.tenantId, f.departmentId, f.locationId],
      );
      expect(inserted.rows[0].full_name).toBe("Эрдэнэ Болд");
    });
  });
});
