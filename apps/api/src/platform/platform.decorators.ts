import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { PlatformContext, PlatformRequest } from "./platform.types";

export const CurrentPlatform = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): PlatformContext => {
    const request = ctx.switchToHttp().getRequest<PlatformRequest>();
    if (!request.platform) throw new Error("CurrentPlatform used on a route without PlatformGuard");
    return request.platform;
  },
);
