import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";

/** Renders every error as RFC 7807 problem+json with a stable `code`. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

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

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(500).type("application/problem+json").json({
      title: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "An unexpected error occurred.",
    });
  }
}
