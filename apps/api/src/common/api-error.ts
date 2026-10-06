import { HttpException } from "@nestjs/common";

/** Error with a stable machine-readable `code` (Architecture 9.1: RFC 7807 problem+json). */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ code, detail, ...extra }, status);
  }
}

export const invalidCredentials = () =>
  new ApiError(401, "INVALID_CREDENTIALS", "Invalid organization, username or password.");
export const unauthorized = (detail = "Authentication required.") =>
  new ApiError(401, "UNAUTHENTICATED", detail);
export const forbidden = (detail = "You do not have permission to perform this action.") =>
  new ApiError(403, "FORBIDDEN", detail);
