import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { raw } from "express";
import { AuthModule } from "../auth/auth.module";
import { EmployeeImportController } from "./employee-import.controller";
import { EmployeeImportService } from "./employee-import.service";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { JobHistoryService } from "./job-history.service";

@Module({
  imports: [AuthModule],
  controllers: [EmployeeImportController, EmployeesController],
  providers: [EmployeesService, JobHistoryService, EmployeeImportService],
  exports: [EmployeesService],
})
export class EmployeesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The import file arrives as the raw request body.
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
      .forRoutes({ path: "employees/import", method: RequestMethod.POST });
  }
}
