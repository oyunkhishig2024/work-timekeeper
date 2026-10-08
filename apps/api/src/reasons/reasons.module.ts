import { Module } from "@nestjs/common";
import { AttendanceModule } from "../attendance/attendance.module";
import { ReasonAssignmentsController, ReasonsController } from "./reasons.controller";
import { ReasonsService } from "./reasons.service";

@Module({
  imports: [AttendanceModule],
  controllers: [ReasonsController, ReasonAssignmentsController],
  providers: [ReasonsService],
  exports: [ReasonsService],
})
export class ReasonsModule {}
