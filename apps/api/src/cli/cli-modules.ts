import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ConsentModule } from "../consent/consent.module";
import { DatabaseModule } from "../database/database.module";
import { PlatformModule } from "../platform/platform.module";
import { StorageModule } from "../storage/storage.module";
import { UsersModule } from "../users/users.module";

// The modules the command-line tools start (node dist/cli/<tool>.js). They are listed here, not inside each tool, so a test
// can build every one of them: a service that gains a new dependency (such as ScopeService from the global AccessModule)
// must be provided here too, and a tool that cannot start is caught by test/e2e/cli-modules.test.ts, not on the server.

/** create-user and reset-password. */
@Module({ imports: [DatabaseModule, AccessModule, AuditModule, AuthModule, UsersModule] })
export class UserCliModule {}

/** create-platform-user. */
@Module({ imports: [DatabaseModule, AccessModule, AuditModule, AuthModule, PlatformModule] })
export class PlatformCliModule {}

/** load-consent-text. */
@Module({
  imports: [DatabaseModule, AccessModule, AuditModule, StorageModule, AuthModule, ConsentModule],
})
export class ConsentCliModule {}
