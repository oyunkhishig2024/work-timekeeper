import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ApiError } from "../common/api-error";
import { AuthService } from "./auth.service";
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  totpEnableSchema,
  totpVerifySchema,
} from "./auth.schemas";
import type { AuthContext, RequestMeta } from "./auth.types";
import { AllowLimited, AnyRole, CurrentAuth, Meta, Public } from "./decorators";
import { clearRefreshCookie, deliverTokens, isWebClient, refreshTokenOf } from "./refresh-cookie";

@Controller("auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Step 1: organization code + username + password. May ask for a second step (TOTP). */
  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(loginSchema.parse(body), meta);
    return "tokens" in result
      ? { ...result, tokens: deliverTokens(req, res, result.tokens) }
      : result;
  }

  /** Step 2 (admin roles): authenticator code or a one-time recovery code. */
  @Public()
  @Post("totp/verify")
  @HttpCode(200)
  async totpVerify(
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return deliverTokens(req, res, await this.auth.verifyMfa(totpVerifySchema.parse(body), meta));
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = refreshTokenOf(req, refreshSchema.parse(body ?? {}).refreshToken);
    try {
      return deliverTokens(req, res, await this.auth.refresh(token, meta));
    } catch (error) {
      // A refused cookie (expired, replaced, revoked) is useless: remove it so the browser stops sending it.
      if (isWebClient(req) && error instanceof ApiError && error.getStatus() === 401) {
        clearRefreshCookie(req, res);
      }
      throw error;
    }
  }

  @AnyRole()
  @AllowLimited()
  @Post("logout")
  @HttpCode(204)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth, meta);
    if (isWebClient(req)) clearRefreshCookie(req, res);
  }

  @AnyRole()
  @AllowLimited()
  @Get("me")
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @AnyRole()
  @AllowLimited()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("password/change")
  @HttpCode(200)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.changePassword(auth, changePasswordSchema.parse(body), meta);
    return deliverTokens(req, res, tokens);
  }

  @AnyRole()
  @AllowLimited()
  @Post("totp/setup")
  @HttpCode(200)
  totpSetup(@CurrentAuth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.auth.totpSetup(auth, meta);
  }

  @AnyRole()
  @AllowLimited()
  @Post("totp/enable")
  @HttpCode(200)
  async totpEnable(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tokens, recoveryCodes } = await this.auth.totpEnable(
      auth,
      totpEnableSchema.parse(body).code,
      meta,
    );
    return { ...deliverTokens(req, res, tokens), recoveryCodes };
  }
}
