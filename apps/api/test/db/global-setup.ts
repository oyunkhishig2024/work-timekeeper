import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { runner } from "node-pg-migrate";

/**
 * Database tests run only when TEST_DATABASE_URL is set. The schema is dropped and rebuilt from the
 * migrations before every run, so the database name must end with "_test" to protect real data.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;

  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to reset database "${dbName}": its name must end with "_test".`);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.end();

  await runner({
    databaseUrl: url,
    dir: fileURLToPath(new URL("../../db/migrations", import.meta.url)),
    direction: "up",
    migrationsTable: "pgmigrations",
    ignorePattern: "(README\\.md|\\..*)",
    log: () => {},
  });
}
