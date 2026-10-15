import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { Meta, Public } from "../auth/decorators";
import type { RequestMeta } from "../auth/auth.types";
import { CurrentPlatform } from "./platform.decorators";
import { PlatformGuard } from "./platform.guard";
import { PlatformTenantsService } from "./platform-tenants.service";
import type { PlatformContext } from "./platform.types";

const username = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const createSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().trim().min(1).max(120),
  timeZone: z.string().trim().min(1).max(64).default("Asia/Ulaanbaatar"),
  adminUsername: username,
  adminDisplayName: z.string().trim().min(1).max(120),
});
const renameSchema = z.object({ name: z.string().trim().min(1).max(120) });
const addAdminSchema = z.object({ username, displayName: z.string().trim().min(1).max(120) });
const resetSchema = z.object({ username, totp: z.boolean().default(false) });
const activitySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Organizations, for the Super Admin only. `@Public()` skips the tenant guard; PlatformGuard is the real check. */
@Public()
@UseGuards(PlatformGuard)
@Controller("platform")
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}

  @Get("tenants")
  list() {
    return this.tenants.list();
  }

  @Post("tenants")
  create(
    @CurrentPlatform() ctx: PlatformContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.create(ctx, createSchema.parse(body), meta);
  }

  @Get("tenants/:id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.tenants.get(id);
  }

  @Patch("tenants/:id")
  rename(
    @CurrentPlatform() ctx: PlatformContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.rename(ctx, id, renameSchema.parse(body).name, meta);
  }

  @Post("tenants/:id/suspend")
  @HttpCode(200)
  suspend(
    @CurrentPlatform() ctx: PlatformContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.setStatus(ctx, id, "SUSPENDED", meta);
  }

  @Post("tenants/:id/activate")
  @HttpCode(200)
  activate(
    @CurrentPlatform() ctx: PlatformContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.setStatus(ctx, id, "ACTIVE", meta);
  }

  @Post("tenants/:id/admins")
  addAdmin(
    @CurrentPlatform() ctx: PlatformContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.addAdmin(ctx, id, addAdminSchema.parse(body), meta);
  }

  @Post("tenants/:id/admins/reset")
  @HttpCode(200)
  resetAdmin(
    @CurrentPlatform() ctx: PlatformContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    const input = resetSchema.parse(body);
    return this.tenants.resetAdmin(ctx, id, input.username, { totp: input.totp }, meta);
  }

  @Get("activity")
  activity(@Query() query: unknown) {
    return this.tenants.activity(activitySchema.parse(query).limit);
  }
}
