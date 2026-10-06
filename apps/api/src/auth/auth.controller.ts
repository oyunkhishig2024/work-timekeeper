import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  totpEnableSchema,
  totpVerifySchema,
} from "./auth.schemas";
import type { AuthContext, RequestMeta } from "./auth.types";
import { AllowLimited, CurrentAuth, Meta, Public } from "./decorators";

@Controller("auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Step 1: organization code + username + password. May ask for a second step (TOTP). */
  @Public()
  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.auth.login(loginSchema.parse(body), meta);
  }

  /** Step 2 (admin roles): authenticator code or a one-time recovery code. */
  @Public()
  @Post("totp/verify")
  @HttpCode(200)
  totpVerify(@Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.auth.verifyMfa(totpVerifySchema.parse(body), meta);
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  refresh(@Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.auth.refresh(refreshSchema.parse(body).refreshToken, meta);
  }

  @AllowLimited()
  @Post("logout")
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.logout(auth, meta);
  }

  @AllowLimited()
  @Get("me")
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @AllowLimited()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("password/change")
  @HttpCode(200)
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.auth.changePassword(auth, changePasswordSchema.parse(body), meta);
  }

  @AllowLimited()
  @Post("totp/setup")
  @HttpCode(200)
  totpSetup(@CurrentAuth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.auth.totpSetup(auth, meta);
  }

  @AllowLimited()
  @Post("totp/enable")
  @HttpCode(200)
  async totpEnable(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    const { tokens, recoveryCodes } = await this.auth.totpEnable(
      auth,
      totpEnableSchema.parse(body).code,
      meta,
    );
    return { ...tokens, recoveryCodes };
  }
}
