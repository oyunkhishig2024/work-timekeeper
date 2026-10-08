import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ScheduleModule } from "../schedule/schedule.module";
import {
  AnomaliesController,
  AttendanceController,
  CorrectionsController,
  DeviceEventsController,
} from "./attendance.controller";
import { AnomaliesService } from "./anomalies.service";
import { CorrectionsService } from "./corrections.service";
import { AttendanceService } from "./attendance.service";

@Module({
  imports: [AuthModule, ScheduleModule],
  controllers: [
    DeviceEventsController,
    AttendanceController,
    CorrectionsController,
    AnomaliesController,
  ],
  providers: [AttendanceService, CorrectionsService, AnomaliesService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
