import type { Request, Response } from "express";
import { ApiError, unauthorized } from "../common/api-error";
import type { AuthTokens } from "./auth.types";

/**
 * The web app keeps the refresh token in an httpOnly cookie, so no page script can read it (a cross-site-scripting bug could
 * otherwise steal a long-lived credential). The phone app sends and receives the token in the JSON body as before.
 *
 * A request is from the web app when it carries `X-TK-Client: web`. A cross-site page cannot add a custom header without a CORS
 * preflight (this API allows none), so the header, together with SameSite=Strict, also stops cross-site request forgery on the
 * cookie-based endpoints.
 */
export const REFRESH_COOKIE = "tk_rt";
const CLIENT_HEADER = "x-tk-client";
const COOKIE_PATH = "/v1/auth";

export const isWebClient = (req: Request): boolean => req.headers[CLIENT_HEADER] === "web";

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Behind the proxy the connection to the API is plain HTTP; the proxy says what the browser used. */
const secure = (req: Request): boolean =>
  req.secure ||
  String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]!
    .trim() === "https";

function cookie(req: Request, value: string, maxAge?: number): string {
  const parts = [
    `${REFRESH_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure(req)) parts.push("Secure");
  // No Max-Age: a session cookie, gone when the browser closes. The server decides how long the session really lives.
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

export function clearRefreshCookie(req: Request, res: Response): void {
  res.append("Set-Cookie", cookie(req, "", 0));
}

/** Web client: the token goes into the cookie and is removed from the body. Phone client: the body is unchanged. */
export function deliverTokens(req: Request, res: Response, tokens: AuthTokens): AuthTokens {
  if (!isWebClient(req)) return tokens;
  res.append("Set-Cookie", cookie(req, encodeURIComponent(tokens.refreshToken)));
  const body: Partial<AuthTokens> = { ...tokens };
  delete body.refreshToken;
  return body as AuthTokens;
}

/** The refresh token of a request: from the body (phone), else from the cookie (web, which must also send the client header). */
export function refreshTokenOf(req: Request, bodyToken: string | undefined): string {
  if (bodyToken) return bodyToken;
  const fromCookie = readRefreshCookie(req);
  if (!fromCookie) throw unauthorized("Invalid refresh token.");
  if (!isWebClient(req)) {
    throw new ApiError(
      403,
      "CLIENT_HEADER_REQUIRED",
      "The cookie session needs the X-TK-Client header.",
    );
  }
  return decodeURIComponent(fromCookie);
}
