import { Module } from "@nestjs/common";
import { ReasonAssignmentsController, ReasonsController } from "./reasons.controller";
import { ReasonsService } from "./reasons.service";

@Module({
  controllers: [ReasonsController, ReasonAssignmentsController],
  providers: [ReasonsService],
  exports: [ReasonsService],
})
export class ReasonsModule {}
