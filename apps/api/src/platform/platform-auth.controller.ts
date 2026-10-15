import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { z } from "zod";
import { loadConfig } from "../common/config";
import { AllowLimited, Meta, Public } from "../auth/decorators";
import type { RequestMeta } from "../auth/auth.types";
import { changePasswordSchema, totpEnableSchema } from "../auth/auth.schemas";
import { CurrentPlatform } from "./platform.decorators";
import { PlatformAuthService } from "./platform-auth.service";
import { PlatformGuard } from "./platform.guard";
import type { PlatformContext } from "./platform.types";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
});
const verifySchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().trim().min(1).max(16),
});

/** Sign-in of the Super Admin. Every route is `@Public()` for the tenant guard; the account routes use PlatformGuard instead. */
@Public()
@Controller("platform/auth")
@UseGuards(ThrottlerGuard)
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.auth.login(loginSchema.parse(body), meta);
  }

  @Post("totp/verify")
  @HttpCode(200)
  verify(@Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.auth.verifyMfa(verifySchema.parse(body), meta);
  }

  @UseGuards(PlatformGuard)
  @AllowLimited()
  @Post("logout")
  @HttpCode(204)
  async logout(@CurrentPlatform() ctx: PlatformContext, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.logout(ctx, meta);
  }

  @UseGuards(PlatformGuard)
  @AllowLimited()
  @Get("me")
  me(@CurrentPlatform() ctx: PlatformContext) {
    return this.auth.me(ctx);
  }

  @UseGuards(PlatformGuard)
  @AllowLimited()
  @Throttle({
    default: { limit: Math.ceil(loadConfig().AUTH_RATE_LIMIT_PER_MINUTE / 2), ttl: 60_000 },
  })
  @Post("password/change")
  @HttpCode(200)
  changePassword(
    @CurrentPlatform() ctx: PlatformContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.auth.changePassword(ctx, changePasswordSchema.parse(body), meta);
  }

  @UseGuards(PlatformGuard)
  @AllowLimited()
  @Post("totp/setup")
  @HttpCode(200)
  totpSetup(@CurrentPlatform() ctx: PlatformContext, @Meta() meta: RequestMeta) {
    return this.auth.totpSetup(ctx, meta);
  }

  @UseGuards(PlatformGuard)
  @AllowLimited()
  @Post("totp/enable")
  @HttpCode(200)
  totpEnable(
    @CurrentPlatform() ctx: PlatformContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.auth.totpEnable(ctx, totpEnableSchema.parse(body).code, meta);
  }
}
