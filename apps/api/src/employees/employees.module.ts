import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { JobCatalogService } from "./job-catalog.service";
import { JobHistoryService } from "./job-history.service";
import { PositionsController, RanksController } from "./job.controller";

@Module({
  imports: [AuthModule],
  controllers: [EmployeesController, RanksController, PositionsController],
  providers: [EmployeesService, JobCatalogService, JobHistoryService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
