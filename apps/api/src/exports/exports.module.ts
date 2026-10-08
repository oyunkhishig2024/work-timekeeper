import { Module } from "@nestjs/common";
import { AttendanceModule } from "../attendance/attendance.module";
import { EmployeesModule } from "../employees/employees.module";
import { ReasonsModule } from "../reasons/reasons.module";
import { ScheduleModule } from "../schedule/schedule.module";
import { ExportsController } from "./exports.controller";
import { ExportsService } from "./exports.service";

@Module({
  imports: [AttendanceModule, EmployeesModule, ReasonsModule, ScheduleModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
