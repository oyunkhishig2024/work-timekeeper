import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { UserCliModule } from "./cli-modules";
import { ApiError } from "../common/api-error";
import { DatabaseService } from "../database/database.service";
import { UsersService } from "../users/users.service";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Recovery tool for the server console, for the case the web app cannot help: the only Organization Admin forgot the
 * password (or lost the authenticator phone).
 *   node dist/cli/reset-password.js --org 310 --username admin
 *   node dist/cli/reset-password.js --org 310 --username admin --totp      (also removes the authenticator)
 * Prints a one-time password; the person must change it at the next sign-in. Every session of the account ends and a
 * lockout is cleared. The reset is written to the audit log as "system:cli".
 */
async function main(): Promise<void> {
  const org = arg("org");
  const username = arg("username");
  const totp = process.argv.includes("--totp");
  if (!org || !username) {
    console.error("Usage: reset-password --org <code> --username <name> [--totp]");
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(UserCliModule, { logger: ["error"] });
  try {
    const tenantId = await app.get(DatabaseService).resolveTenant(org);
    if (!tenantId) throw new Error(`Unknown or inactive organization code "${org}"`);
    const result = await app
      .get(UsersService)
      .resetFromConsole(tenantId, username, { totp }, { ip: null, userAgent: "cli" });
    console.log(`Reset ${result.role} "${result.username}" in organization "${org}".`);
    console.log(`Temporary password (shown once): ${result.temporaryPassword}`);
    if (result.totpRemoved)
      console.log("The authenticator was removed; it is set up again at the next sign-in.");
    if (result.role === "ORG_ADMIN" && result.activeOrgAdmins < 2) {
      console.log(
        "WARNING: this is the only active Organization Admin. Create a second one (create-user --role ORG_ADMIN) so that a lost password never needs the server console.",
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // An ApiError keeps its text in `detail`; its Error message is only "Api Error".
  console.error(
    error instanceof ApiError
      ? error.getResponse()["detail" as never]
      : error instanceof Error
        ? error.message
        : error,
  );
  process.exit(1);
});
