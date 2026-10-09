/** An answer of the API that is not a success: RFC 7807 problem with a stable `code` (apps/api/src/auth/README.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The phone could not reach the server at all (no network, timeout). Safe to retry later. */
export class NetworkError extends Error {
  constructor(message = "network") {
    super(message);
    this.name = "NetworkError";
  }
}

/** The session is over (refresh failed or revoked): the person has to sign in again. */
export class SessionEndedError extends Error {
  constructor() {
    super("session ended");
    this.name = "SessionEndedError";
  }
}
