import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module";
import { AttendanceService } from "./attendance/attendance.service";
import { AttendanceTicker } from "./attendance/attendance.ticker";
import { DatabaseModule } from "./database/database.module";
import { ExpectationLoader } from "./schedule/expectation-loader.service";

/**
 * Worker process root module (no HTTP server). Job handlers and schedulers are registered here; see
 * docs/Timekeeper_Work_Architecture.md Section 6.6. Today: the attendance tick (PENDING -> NO_SHOW at the cut-off).
 */
@Module({
  imports: [DatabaseModule, AccessModule],
  providers: [ExpectationLoader, AttendanceService, AttendanceTicker],
})
export class WorkerModule {}
