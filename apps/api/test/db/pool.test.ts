import { describe, expect, it } from "vitest";
import { DatabaseService } from "../../src/database/database.service";
import { loadConfig } from "../../src/common/config";
import { hasDb } from "./helpers";

const service = (env: Record<string, string>): DatabaseService =>
  new DatabaseService(loadConfig({ ...process.env, ...env }));

describe.skipIf(!hasDb)("database pool limits", () => {
  it("stops a query that runs past the statement timeout", async () => {
    const db = service({ DB_STATEMENT_TIMEOUT_MS: "200" });
    try {
      await expect(db.asPlatform((c) => c.query("SELECT pg_sleep(3)"))).rejects.toMatchObject({
        code: "57014",
      });
    } finally {
      await db.onModuleDestroy();
    }
  });

  it("drops a transaction left open and idle, without crashing the process", async () => {
    const db = service({ DB_IDLE_TX_TIMEOUT_MS: "200" });
    try {
      await expect(
        db.asPlatform(async (c) => {
          await new Promise((r) => setTimeout(r, 600));
          await c.query("SELECT 1");
        }),
      ).rejects.toThrow();
    } finally {
      await db.onModuleDestroy();
    }
  });

  it("fails fast when every connection is busy", async () => {
    const db = service({ DB_POOL_MAX: "1", DB_CONNECT_TIMEOUT_MS: "300" });
    try {
      const slow = db.asPlatform((c) => c.query("SELECT pg_sleep(1)"));
      await new Promise((r) => setTimeout(r, 50));
      await expect(db.asPlatform((c) => c.query("SELECT 1"))).rejects.toThrow(
        "timeout exceeded when trying to connect",
      );
      await slow;
    } finally {
      await db.onModuleDestroy();
    }
  });

  it("names the connection for the database operator", async () => {
    const db = service({});
    try {
      const { rows } = await db.asPlatform((c) =>
        c.query<{ n: string }>("SELECT current_setting('application_name') AS n"),
      );
      expect(rows[0]?.n).toBe("timekeeper");
    } finally {
      await db.onModuleDestroy();
    }
  });
});
