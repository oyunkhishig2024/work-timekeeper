import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DevicesModule } from "../devices/devices.module";
import { ScheduleModule } from "../schedule/schedule.module";
import {
  AnomaliesController,
  AttendanceController,
  CorrectionsController,
  DeviceAlertsController,
  DeviceEventsController,
} from "./attendance.controller";
import { AnomaliesService } from "./anomalies.service";
import { DeviceAlertsService } from "./device-alerts.service";
import { CorrectionsService } from "./corrections.service";
import { AttendanceService } from "./attendance.service";

@Module({
  imports: [AuthModule, ScheduleModule, DevicesModule],
  controllers: [
    DeviceEventsController,
    AttendanceController,
    CorrectionsController,
    AnomaliesController,
    DeviceAlertsController,
  ],
  providers: [AttendanceService, CorrectionsService, AnomaliesService, DeviceAlertsService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
