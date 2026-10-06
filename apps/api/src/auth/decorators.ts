import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthContext, AuthedRequest } from "./auth.types";
import type { Role } from "./roles";

export const IS_PUBLIC = "auth:public";
export const ALLOW_LIMITED = "auth:allowLimited";
export const ROLES = "auth:roles";

/** No authentication required (login, refresh, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Reachable even while the user still has to change their password / set up TOTP. */
export const AllowLimited = () => SetMetadata(ALLOW_LIMITED, true);

/** Restrict a route or controller to these roles. Without it, any authenticated role may call it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!request.auth) throw new Error("CurrentAuth used on a route without authentication");
    return request.auth;
  },
);

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthedRequest>();
  return { ip: request.ip ?? null, userAgent: request.headers["user-agent"] ?? null };
});
