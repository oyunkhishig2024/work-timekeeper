import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError, unauthorized } from "../common/api-error";
import { ALLOW_LIMITED } from "../auth/decorators";
import { PlatformAuthService } from "./platform-auth.service";
import { PlatformTokenService } from "./platform-token.service";
import type { PlatformRequest } from "./platform.types";

/**
 * Guard of the Super Admin routes (`/v1/platform/...`). The tenant guard skips these routes (`@Public()`); this one takes over:
 * a platform token (its own audience), a live session row, and the "finish setup first" limits. A tenant token never passes.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: PlatformTokenService,
    private readonly auth: PlatformAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const match = request.headers.authorization
      ? /^Bearer (.+)$/iu.exec(request.headers.authorization)
      : null;
    if (!match) throw unauthorized();
    const claims = await this.tokens.verifyAccess(match[1]!);
    const live = await this.auth.loadLive(claims.userId, claims.sessionId);
    if (!live) throw unauthorized("The session is no longer valid.");
    request.platform = {
      userId: claims.userId,
      username: live.username,
      sessionId: claims.sessionId,
      limited: live.limited,
    };
    if (
      live.limited.length > 0 &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_LIMITED, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      throw new ApiError(403, "SETUP_REQUIRED", "Finish the required account setup first.", {
        required: live.limited,
      });
    }
    return true;
  }
}
