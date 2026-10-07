import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ConsentModule } from "../consent/consent.module";
import { ConsentService } from "../consent/consent.service";
import { DatabaseModule } from "../database/database.module";
import { DatabaseService } from "../database/database.service";
import { StorageModule } from "../storage/storage.module";

@Module({ imports: [DatabaseModule, AuditModule, StorageModule, AuthModule, ConsentModule] })
class CliModule {}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Loads a consent text from a file into a tenant. The change is audited as done by "system:cli".
 *   node dist/cli/load-consent-text.js --org 310 --version consent-v1-draft --file docs/consent/consent-v1-draft.mn.txt --draft --activate
 * Pass --draft for texts that are not legally approved yet (they cannot be printed in production).
 */
async function main(): Promise<void> {
  const org = arg("org");
  const version = arg("version");
  const file = arg("file");
  if (!org || !version || !file) {
    console.error(
      "Usage: load-consent-text --org <code> --version <id> --file <path> [--draft] [--activate]",
    );
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ["error"] });
  try {
    const tenantId = await app.get(DatabaseService).resolveTenant(org);
    if (!tenantId) throw new Error(`Unknown or inactive organization code "${org}"`);
    const body = await readFile(file, "utf8");
    // The CLI is not a signed-in user: it acts as "system:cli" (the casts satisfy the AuthContext type; the
    // audit log records actor "system:cli" with no user id).
    const auth = {
      userId: null as never,
      tenantId,
      role: "system:cli" as never,
      employeeId: null,
      sessionId: "cli",
      limited: [],
    };
    const meta = { ip: null, userAgent: "cli" };
    const consent = app.get(ConsentService);
    const created = await consent.createText(auth, { version, body, isDraft: flag("draft") }, meta);
    if (flag("activate")) await consent.activateText(auth, created.id, meta);
    console.log(
      `Loaded consent text "${version}" into "${org}"${flag("activate") ? " and activated it" : ""}${flag("draft") ? " (DRAFT)" : ""}.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
