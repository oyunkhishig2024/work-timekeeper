import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { PushSender, WebPushSender } from "./push-sender";

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, { provide: PushSender, useClass: WebPushSender }],
  exports: [NotificationsService, PushSender],
})
export class NotificationsModule {}
