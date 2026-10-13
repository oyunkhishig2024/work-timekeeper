import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { hasDb } from "./helpers";

const dir = fileURLToPath(new URL("../../db/migrations", import.meta.url));

/**
 * Every migration must be undoable: all the way down and up again must give the same schema, in a scratch database
 * (created next to the test database and dropped afterwards).
 */
describe.skipIf(!hasDb)("migrations round trip", () => {
  const base = new URL(process.env.TEST_DATABASE_URL ?? "postgres://x/x_test");
  const scratchName = `${base.pathname.slice(1)}_roundtrip`;
  const scratch = new URL(base);
  scratch.pathname = `/${scratchName}`;

  afterAll(async () => {
    const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
    await admin.end();
  });

  const run = (direction: "up" | "down", count?: number) =>
    runner({
      databaseUrl: scratch.toString(),
      dir,
      direction,
      count: count ?? (direction === "down" ? Infinity : undefined),
      migrationsTable: "pgmigrations",
      ignorePattern: "(README\\.md|\\..*)",
      log: () => {},
    });

  const signature = async (): Promise<string> => {
    const c = new Client({ connectionString: scratch.toString() });
    await c.connect();
    try {
      const q = async (sql: string) => (await c.query<{ s: string }>(sql)).rows.map((r) => r.s);
      return JSON.stringify({
        columns: await q(
          `SELECT table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') AS s
             FROM information_schema.columns WHERE table_schema='public' ORDER BY 1`,
        ),
        indexes: await q(
          `SELECT indexdef AS s FROM pg_indexes WHERE schemaname='public' ORDER BY 1`,
        ),
        constraints: await q(
          `SELECT conrelid::regclass||'.'||conname||':'||pg_get_constraintdef(oid) AS s FROM pg_constraint
            WHERE connamespace='public'::regnamespace ORDER BY 1`,
        ),
        functions: await q(
          `SELECT pg_get_functiondef(p.oid) AS s FROM pg_proc p WHERE pronamespace='public'::regnamespace ORDER BY 1`,
        ),
        triggers: await q(
          `SELECT pg_get_triggerdef(oid) AS s FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
        ),
      });
    } finally {
      await c.end();
    }
  };

  it("goes down to nothing and up again with an identical schema", async () => {
    const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    await admin.end();

    await run("up");
    const first = await signature();
    await run("down");
    await run("up");
    expect(await signature()).toEqual(first);
  }, 120_000);
});
