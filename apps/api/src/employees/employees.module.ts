import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { JobHistoryService } from "./job-history.service";

@Module({
  imports: [AuthModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, JobHistoryService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
