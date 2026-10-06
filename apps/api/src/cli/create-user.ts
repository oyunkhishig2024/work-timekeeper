import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { DatabaseService } from "../database/database.service";
import { UsersModule } from "../users/users.module";
import { UsersService } from "../users/users.service";

@Module({ imports: [DatabaseModule, AuditModule, AuthModule, UsersModule] })
class CliModule {}

const ROLES = ["ORG_ADMIN", "HR", "MANAGER"] as const;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Bootstrap tool: creates a staff user in a tenant (the first Organization Admin is created this way
 * until the Super Admin UI exists, PRD 17.1).
 *   node dist/cli/create-user.js --org 310 --username khongor --name "Khongor" --role ORG_ADMIN
 * Prints a one-time temporary password; the user must change it at first login.
 */
async function main(): Promise<void> {
  const org = arg("org");
  const username = arg("username");
  const name = arg("name");
  const role = arg("role") as (typeof ROLES)[number] | undefined;
  if (!org || !username || !name || !role || !ROLES.includes(role)) {
    console.error(
      `Usage: create-user --org <code> --username <name> --name "<display name>" --role ${ROLES.join("|")}`,
    );
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ["error"] });
  try {
    const tenantId = await app.get(DatabaseService).resolveTenant(org);
    if (!tenantId) throw new Error(`Unknown or inactive organization code "${org}"`);
    const created = await app
      .get(UsersService)
      .create(
        tenantId,
        { username, displayName: name, role: role as "HR" | "MANAGER" },
        { userId: null, role: "system:cli" },
        { ip: null, userAgent: "cli" },
      );
    console.log(`Created ${created.role} "${created.username}" in organization "${org}".`);
    console.log(`Temporary password (shown once): ${created.temporaryPassword}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
