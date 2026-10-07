import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { ProblemFilter } from "./common/problem.filter";
import { ConsentModule } from "./consent/consent.module";
import { DatabaseModule } from "./database/database.module";
import { DevicesModule } from "./devices/devices.module";
import { HealthModule } from "./modules/health/health.module";
import { StorageModule } from "./storage/storage.module";
import { UsersModule } from "./users/users.module";

/**
 * API process root module. Business modules (tenancy, org, employees, devices, consent, schedule, rules,
 * events, attendance, reasons, reporting, platform) are added here as they are built; see
 * docs/Timekeeper_Work_Architecture.md Section 3.
 */
@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    StorageModule,
    AuthModule,
    UsersModule,
    DevicesModule,
    ConsentModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}
