import { Module } from "@nestjs/common";
import { AttendanceModule } from "../attendance/attendance.module";
import { PersonalHoursController } from "./personal-hours.controller";
import { PersonalHoursService } from "./personal-hours.service";

@Module({
  imports: [AttendanceModule],
  controllers: [PersonalHoursController],
  providers: [PersonalHoursService],
})
export class PersonalHoursModule {}
