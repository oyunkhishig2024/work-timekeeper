import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { requestIdOf } from "./request-id";

/** A Postgres error that no service translated itself: a rule of the database was broken (class 22, 23, 40). */
const isPgError = (e: unknown): e is { code: string; severity?: string; constraint?: string } =>
  typeof e === "object" &&
  e !== null &&
  typeof (e as { code?: unknown }).code === "string" &&
  /^[0-9A-Z]{5}$/u.test((e as { code: string }).code) &&
  "severity" in e;

/** What the person is told about a database rule that was broken. The constraint name stays in the log. */
function pgProblem(code: string): { status: number; code: string; detail: string } | null {
  if (code === "23505")
    return {
      status: 409,
      code: "DUPLICATE",
      detail: "A record with the same value already exists.",
    };
  if (code === "23503")
    return {
      status: 409,
      code: "REFERENCE_CONFLICT",
      detail:
        "The record refers to something that does not exist, or is still used by something else.",
    };
  if (code === "23P01")
    return { status: 409, code: "OVERLAP", detail: "The record overlaps an existing one." };
  if (["23502", "23514", "22001", "22003", "22007", "22008", "22023", "22P02"].includes(code))
    return {
      status: 400,
      code: "INVALID_DATA",
      detail: "A value is missing, too long or not allowed.",
    };
  if (code === "40001" || code === "40P01")
    return {
      status: 503,
      code: "TRY_AGAIN",
      detail: "The server was busy with a conflicting change. Try again.",
    };
  if (code === "57014" || code === "25P03")
    return {
      status: 503,
      code: "QUERY_TIMEOUT",
      detail: "The request took too long and was stopped. Try again.",
    };
  return null;
}

/** The connection pool gave up waiting for a free database connection (DB_CONNECT_TIMEOUT_MS), or the server dropped it. */
const isPoolTimeout = (e: unknown): boolean =>
  e instanceof Error &&
  (e.message === "timeout exceeded when trying to connect" ||
    e.message === "Connection terminated unexpectedly");

/** Renders every error as RFC 7807 problem+json with a stable `code`, and the id of the request (`requestId`). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = requestIdOf(res);
    // Every body below carries the request id, so a report from a user finds the line in the log.
    const send = res.json.bind(res);
    res.json = ((body: unknown) =>
      send(requestId ? { ...(body as object), requestId } : body)) as typeof res.json;

    if (exception instanceof ZodError) {
      res
        .status(400)
        .type("application/problem+json")
        .json({
          title: "Bad Request",
          status: 400,
          code: "VALIDATION_ERROR",
          detail: "The request is invalid.",
          issues: exception.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === "string" ? { detail: body } : (body as Record<string, unknown>);
      // A refusal that says when to come back (429 limits, busy gates) also says it in the standard header.
      if (status === 429 && typeof payload.retryAfterSeconds === "number") {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(payload.retryAfterSeconds))));
      }
      res
        .status(status)
        .type("application/problem+json")
        .json({
          title: exception.name,
          status,
          code:
            payload.code ??
            (status === 404 ? "NOT_FOUND" : status === 429 ? "RATE_LIMITED" : "ERROR"),
          detail: payload.detail ?? payload.message ?? exception.message,
          ...Object.fromEntries(
            Object.entries(payload).filter(
              ([k]) => !["code", "detail", "message", "statusCode", "error"].includes(k),
            ),
          ),
        });
      return;
    }

    if (isPoolTimeout(exception)) {
      this.logger.warn(`database pool exhausted, request ${requestId ?? "-"}`);
      res.setHeader("Retry-After", "2").status(503).type("application/problem+json").json({
        title: "Service Unavailable",
        status: 503,
        code: "DB_BUSY",
        detail: "The server is busy. Try again in a moment.",
      });
      return;
    }

    if (isPgError(exception)) {
      const problem = pgProblem(exception.code);
      if (problem) {
        this.logger.warn(
          `database rule broken (${exception.code}${exception.constraint ? `, ${exception.constraint}` : ""}) request ${requestId ?? "-"}`,
        );
        if (problem.status === 503) res.setHeader("Retry-After", "1");
        res
          .status(problem.status)
          .type("application/problem+json")
          .json({
            title:
              problem.status === 503
                ? "Service Unavailable"
                : problem.status === 409
                  ? "Conflict"
                  : "Bad Request",
            status: problem.status,
            code: problem.code,
            detail: problem.detail,
          });
        return;
      }
    }

    // Errors from Express middleware (for example body-parser) carry an HTTP status of their own.
    const status = (exception as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const type = (exception as { type?: string }).type;
      res
        .status(status)
        .type("application/problem+json")
        .json({
          title: "Bad Request",
          status,
          code:
            status === 413
              ? "PAYLOAD_TOO_LARGE"
              : type === "entity.parse.failed"
                ? "INVALID_JSON"
                : "BAD_REQUEST",
          detail: "The request could not be processed.",
        });
      return;
    }

    this.logger.error(
      `request ${requestId ?? "-"}: ${exception instanceof Error ? exception.stack : String(exception)}`,
    );
    res.status(500).type("application/problem+json").json({
      title: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "An unexpected error occurred.",
    });
  }
}
