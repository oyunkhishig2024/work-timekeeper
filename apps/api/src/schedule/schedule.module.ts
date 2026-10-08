import { Module } from "@nestjs/common";
import { HolidaysService } from "./holidays.service";
import {
  HolidaysController,
  ShiftConfigController,
  ShiftRosterController,
  WorkingWeekController,
} from "./schedule.controller";
import { ShiftsService } from "./shifts.service";
import { WorkingWeekService } from "./working-week.service";

@Module({
  controllers: [
    WorkingWeekController,
    HolidaysController,
    ShiftConfigController,
    ShiftRosterController,
  ],
  providers: [WorkingWeekService, HolidaysService, ShiftsService],
})
export class ScheduleModule {}
