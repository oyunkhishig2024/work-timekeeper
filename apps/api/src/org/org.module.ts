import { Module } from "@nestjs/common";
import { DepartmentsService } from "./departments.service";
import { LocationsService } from "./locations.service";
import { DepartmentsController, LocationsController } from "./org.controller";

@Module({
  controllers: [DepartmentsController, LocationsController],
  providers: [DepartmentsService, LocationsService],
  exports: [DepartmentsService, LocationsService],
})
export class OrgModule {}
