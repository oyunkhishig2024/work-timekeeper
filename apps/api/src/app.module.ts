import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AccessModule } from "./access/access.module";
import { AttendanceModule } from "./attendance/attendance.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { ProblemFilter } from "./common/problem.filter";
import { ConsentModule } from "./consent/consent.module";
import { DatabaseModule } from "./database/database.module";
import { DevicesModule } from "./devices/devices.module";
import { ExportsModule } from "./exports/exports.module";
import { EmployeesModule } from "./employees/employees.module";
import { HealthModule } from "./modules/health/health.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { OrgModule } from "./org/org.module";
import { PersonalHoursModule } from "./personal-hours/personal-hours.module";
import { ReasonsModule } from "./reasons/reasons.module";
import { ScheduleModule } from "./schedule/schedule.module";
import { SecurityModule } from "./security/security.module";
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
    SecurityModule,
    AuditModule,
    AccessModule,
    StorageModule,
    AuthModule,
    UsersModule,
    OrgModule,
    EmployeesModule,
    DevicesModule,
    ConsentModule,
    ScheduleModule,
    PersonalHoursModule,
    ReasonsModule,
    AttendanceModule,
    NotificationsModule,
    ExportsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}
