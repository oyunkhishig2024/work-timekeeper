import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError, forbidden, unauthorized } from "../../common/api-error";
import { DatabaseService } from "../../database/database.service";
import type { AuthedRequest } from "../auth.types";
import { ALLOW_LIMITED, IS_PUBLIC, ROLES } from "../decorators";
import type { Role } from "../roles";
import { SessionService } from "../session.service";
import { TokenService } from "../token.service";

/**
 * Global guard: authenticates every route unless marked @Public(), checks that the session is still
 * live in the database (so disabling a user or revoking a session takes effect at once, PRD 12.2), then
 * enforces @Roles and the "finish setup first" limits.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    const match = header ? /^Bearer (.+)$/iu.exec(header) : null;
    if (!match) throw unauthorized();

    const claims = await this.tokens.verifyAccess(match[1]!);
    const live = await this.db.withTenant(claims.tid, (tx) => this.sessions.loadLive(tx, claims));
    if (!live) throw unauthorized("The session is no longer valid.");

    request.auth = {
      userId: claims.sub,
      tenantId: claims.tid,
      role: live.role,
      sessionId: claims.sid,
      limited: live.limited,
    };

    if (
      live.limited.length > 0 &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_LIMITED, targets)
    ) {
      throw new ApiError(403, "SETUP_REQUIRED", "Finish the required account setup first.", {
        required: live.limited,
      });
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(live.role)) throw forbidden();
    return true;
  }
}
