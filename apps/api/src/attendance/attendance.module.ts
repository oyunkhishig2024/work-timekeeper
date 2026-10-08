import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ScheduleModule } from "../schedule/schedule.module";
import { AttendanceController, DeviceEventsController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";

@Module({
  imports: [AuthModule, ScheduleModule],
  controllers: [DeviceEventsController, AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
