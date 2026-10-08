import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import type { AuthContext } from "../auth/auth.types";
import { CurrentAuth, Roles } from "../auth/decorators";
import { NotificationsService } from "./notifications.service";

const subscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z
      .object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) })
      .strict(),
  })
  .strict();
const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2048) }).strict();
const inboxQuery = z.object({
  unread: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Org Admin notifications: browser push subscription and the in-app inbox. */
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Roles("ORG_ADMIN")
  @Get("push/config")
  config() {
    return this.notifications.pushConfig();
  }

  @Roles("ORG_ADMIN")
  @Post("push/subscriptions")
  subscribe(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Req() req: Request) {
    const b = subscriptionSchema.parse(body);
    return this.notifications.subscribe(
      auth,
      { endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth },
      req.headers["user-agent"] ?? null,
    );
  }

  @Roles("ORG_ADMIN")
  @Delete("push/subscriptions")
  @HttpCode(200)
  unsubscribe(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.notifications.unsubscribe(auth, unsubscribeSchema.parse(body).endpoint);
  }

  @Roles("ORG_ADMIN")
  @Post("push/test")
  @HttpCode(202)
  test(@CurrentAuth() auth: AuthContext) {
    return this.notifications.test(auth);
  }

  @Roles("ORG_ADMIN")
  @Get("notifications")
  inbox(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    const q = inboxQuery.parse(query);
    return this.notifications.inbox(auth, {
      unreadOnly: q.unread,
      limit: q.limit,
      offset: q.offset,
    });
  }

  @Roles("ORG_ADMIN")
  @Post("notifications/read-all")
  @HttpCode(200)
  readAll(@CurrentAuth() auth: AuthContext) {
    return this.notifications.markRead(auth, null);
  }

  @Roles("ORG_ADMIN")
  @Post("notifications/:notificationId/read")
  @HttpCode(200)
  read(@CurrentAuth() auth: AuthContext, @Param("notificationId") notificationId: string) {
    return this.notifications.markRead(auth, z.string().uuid().parse(notificationId));
  }
}
