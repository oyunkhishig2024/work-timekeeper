import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module";
import { AttendanceService } from "./attendance/attendance.service";
import { AttendanceTicker } from "./attendance/attendance.ticker";
import { AttestationVerifier, ConfiguredAttestationVerifier } from "./devices/attestation";
import { NotificationTicker } from "./notifications/notification.ticker";
import { NotificationsService } from "./notifications/notifications.service";
import { PushSender, WebPushSender } from "./notifications/push-sender";
import { DatabaseModule } from "./database/database.module";
import { ExpectationLoader } from "./schedule/expectation-loader.service";

/**
 * Worker process root module (no HTTP server). Job handlers and schedulers are registered here; see
 * docs/Timekeeper_Work_Architecture.md Section 6.6. Today: the attendance tick (PENDING -> NO_SHOW at the cut-off).
 */
@Module({
  imports: [DatabaseModule, AccessModule],
  providers: [
    ExpectationLoader,
    AttendanceService,
    AttendanceTicker,
    NotificationsService,
    NotificationTicker,
    { provide: PushSender, useClass: WebPushSender },
    { provide: AttestationVerifier, useClass: ConfiguredAttestationVerifier },
  ],
})
export class WorkerModule {}
