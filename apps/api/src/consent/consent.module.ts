import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { raw } from "express";
import { AuthModule } from "../auth/auth.module";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";

@Module({
  imports: [AuthModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Scans arrive as the raw request body.
    consumer
      .apply(raw({ type: ["application/pdf", "image/jpeg", "image/png"], limit: "10mb" }))
      .forRoutes({ path: "consent/records/:recordId/scan", method: RequestMethod.PUT });
  }
}
