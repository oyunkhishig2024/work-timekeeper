import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { PlatformAuthService } from "../platform/platform-auth.service";
import { PlatformModule } from "../platform/platform.module";

@Module({ imports: [DatabaseModule, AuditModule, AuthModule, PlatformModule] })
class CliModule {}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Creates the Super Admin (platform owner), or with --reset gives an existing one a new one-time password and removes the
 * authenticator (lost phone, forgotten password). The first sign-in changes the password and sets up the authenticator.
 *   node dist/cli/create-platform-user.js --username onki --name "Onki"
 *   node dist/cli/create-platform-user.js --username onki --reset
 */
async function main(): Promise<void> {
  const username = arg("username");
  const reset = process.argv.includes("--reset");
  if (!username) {
    console.error(
      'Usage: create-platform-user --username <name> [--name "<display name>"] [--reset]',
    );
    process.exit(2);
  }
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ["error"] });
  try {
    const result = await app
      .get(PlatformAuthService)
      .createOrReset({ username, displayName: arg("name") ?? null }, reset, {
        ip: null,
        userAgent: "cli",
      });
    console.log(`${result.created ? "Created" : "Reset"} Super Admin "${result.username}".`);
    console.log(`Temporary password (shown once): ${result.temporaryPassword}`);
    console.log(
      "Sign in at /platform/login. The first sign-in sets a new password and the authenticator app.",
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ApiError
      ? error.getResponse()["detail" as never]
      : error instanceof Error
        ? error.message
        : error,
  );
  process.exit(1);
});
