import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";

/**
 * API process root module. Business modules (tenancy, identity, org, employees, devices, consent,
 * schedule, rules, events, attendance, reasons, reporting, audit, platform) are added here as they
 * are built; see docs/Timekeeper_Work_Architecture.md Section 3.
 */
@Module({ imports: [HealthModule] })
export class AppModule {}
