import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * Gives every request an id, returned in the `X-Request-Id` header and in every error body (`requestId`), and written next to
 * every logged error. When somebody reports "it failed at 10:42", the id finds the exact log line. A client-supplied id is
 * never trusted: a fresh one is made for each request. Call first, before anything else answers.
 */
export function applyRequestId(app: INestApplication): void {
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Request-Id", randomUUID());
    next();
  });
}

/** The id of the request a response belongs to, if the middleware ran. */
export const requestIdOf = (res: Response): string | undefined => {
  const value = res.getHeader("X-Request-Id");
  return typeof value === "string" ? value : undefined;
};
