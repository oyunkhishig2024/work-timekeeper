import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { hasDb } from "./helpers";

/** Migration 0032: what the API's own database login can and cannot do. */
describe.skipIf(!hasDb)("the limited application login tk_app", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  const rejected = async (sql: string): Promise<string> => {
    try {
      await client.query(sql);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return (error as { code?: string }).code ?? "unknown";
    }
    return "allowed";
  };

  it("is not a superuser and does not bypass Row-Level Security", async () => {
    const { rows } = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>("SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user");
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  });

  it("cannot read tenant data, change the schema or run programs without switching to a runtime role", async () => {
    // 42P01 when the schema is not even visible to the login, 42501 when it is visible but ungranted.
    expect(["42501", "42P01"]).toContain(await rejected("SELECT * FROM employee"));
    expect(await rejected("CREATE TABLE tk_probe (id int)")).not.toBe("allowed");
    expect(await rejected("ALTER TABLE employee DISABLE ROW LEVEL SECURITY")).not.toBe("allowed");
    expect(await rejected("COPY (SELECT 1) TO PROGRAM 'true'")).not.toBe("allowed");
    expect(await rejected("SET ROLE timekeeper")).not.toBe("allowed");
  });

  it("can switch to app_user and platform_admin, as the application does", async () => {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    const { rows } = await client.query<{ n: string }>("SELECT count(*) AS n FROM employee");
    await client.query("ROLLBACK");
    expect(Number(rows[0]?.n)).toBe(0);
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE platform_admin");
    await client.query("ROLLBACK");
  });
});
