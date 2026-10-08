import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AbuseMiddleware } from "./abuse.middleware";

/**
 * Puts the abuse protection in front of EVERYTHING the HTTP server answers, including URLs outside the `/v1` prefix and
 * unknown paths (Nest module middleware only sees routes under the global prefix, so probes like `/.env` or
 * `/wp-login.php` would never reach it). Call before `listen()` / `init()`; it is a no-op when ABUSE_PROTECTION=off.
 */
export function applyAbuseProtection(app: INestApplication): void {
  const middleware = app.get(AbuseMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => {
    middleware.use(req, res, next).catch(next);
  });
}
