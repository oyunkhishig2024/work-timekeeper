import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { raw } from "express";
import { AttendanceRulesService } from "./attendance-rules.service";
import { ExpectationLoader } from "./expectation-loader.service";
import { HolidayImportService } from "./holiday-import.service";
import { HolidaysService } from "./holidays.service";
import {
  AttendanceRulesController,
  HolidaysController,
  RosterController,
  ShiftConfigController,
  ShiftRosterController,
  WorkingWeekController,
} from "./schedule.controller";
import { RosterService } from "./roster.service";
import { ShiftsService } from "./shifts.service";
import { WorkingWeekService } from "./working-week.service";

@Module({
  controllers: [
    RosterController,
    AttendanceRulesController,
    WorkingWeekController,
    HolidaysController,
    ShiftConfigController,
    ShiftRosterController,
  ],
  exports: [HolidaysService, ShiftsService, RosterService, ExpectationLoader],
  providers: [
    HolidayImportService,
    ExpectationLoader,
    RosterService,
    AttendanceRulesService,
    WorkingWeekService,
    HolidaysService,
    ShiftsService,
  ],
})
export class ScheduleModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Holiday files arrive as the raw request body.
    consumer
      .apply(
        raw({
          type: [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/csv",
            "application/csv",
            "application/octet-stream",
          ],
          limit: "5mb",
        }),
      )
      .forRoutes({ path: "holidays/import", method: RequestMethod.POST });
  }
}
