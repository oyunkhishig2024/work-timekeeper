import { Injectable, Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { TokenService } from "../auth/token.service";
import { AbuseService } from "./abuse.service";
import { Clock } from "../common/clock";
import { type Decision, normalize, type Signal } from "./abuse-detector";

/** Paths that only an attacker or a scanner asks for: none of them exists in this application. */
const HONEYPOT =
  /(^|\/)(\.env|\.git|\.svn|\.hg|\.ds_store|\.aws|\.ssh|\.htaccess|\.htpasswd|wp-login\.php|wp-admin|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma|myadmin|adminer|admin\.php|config\.php|phpinfo\.php|shell\.php|cgi-bin|actuator|server-status|server-info|vendor\/phpunit|boot\.ini|web-inf|jenkins|solr|manager\/html|etc\/passwd|etc\/shadow|proc\/self)(\/|$|\?)|\.(php|asp|aspx|jsp|cgi)(\?|$)|\.\.(\/|%2f|%5c|\\)|%2e%2e|%00/iu;

/** User agents of well-known scanning / exploitation tools. */
const SCANNER_UA =
  /sqlmap|nikto|nmap|masscan|acunetix|nessus|openvas|wpscan|dirbuster|gobuster|ffuf|feroxbuster|wfuzz|havij|zgrab|nuclei|burp|metasploit|hydra|jaeles|dirsearch/iu;

/** Login-like endpoints: a 401 there is a failed credential check. */
const AUTH_PATH = /\/auth\/(login|totp\/verify|refresh)\/?$/u;

const normalizePath = (path: string): string =>
  path
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, ":id")
    .replace(/\d+/gu, ":n")
    .slice(0, 120);

/**
 * First line of defence inside the application (the WAF in front of the server is the first line of all, see
 * docs/security). For each request: look at who it is from, refuse or slow it when the behaviour of that address has
 * earned it, and after the response feed what happened (failed logins, probes, 404s ...) back into the detector.
 */
@Injectable()
export class AbuseMiddleware {
  private readonly logger = new Logger("Security");
  private readonly lastBlockedLog = new Map<string, number>();

  constructor(
    private readonly abuse: AbuseService,
    private readonly tokens: TokenService,
    private readonly clock: Clock,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.abuse.enabled) return next();
    const detector = this.abuse.detector;
    const ip = normalize(req.ip ?? req.socket.remoteAddress ?? "");
    if (!ip) return next();
    const now = this.clock.now().getTime();
    const authenticated = await this.hasValidToken(req);

    // One atomic step: look at the address, count the request, and note a refused one as "ignored the limit".
    // Any failure of the state store must never stop a request: fail open.
    let decision: Decision;
    try {
      decision = await detector.admit(ip, authenticated, now);
    } catch (error) {
      this.logger.error(
        JSON.stringify({ event: "security.judgement_failed", error: String(error) }),
      );
      return next();
    }
    if (decision.action !== "allow") {
      this.logBlocked(ip, decision.reason ?? "", now);
      res
        .status(429)
        .setHeader("Retry-After", String(decision.retryAfterSeconds))
        .type("application/problem+json")
        .json({
          title: "Too Many Requests",
          status: 429,
          code: decision.action === "block" ? "IP_TEMPORARILY_BLOCKED" : "RATE_LIMITED",
          detail:
            decision.action === "block"
              ? "Too many suspicious requests from this address. Try again later."
              : "Too many requests. Slow down.",
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      return;
    }

    const userAgent = req.get("user-agent") ?? "";
    if (!authenticated && SCANNER_UA.test(userAgent))
      await detector.record(ip, { type: "SCANNER_USER_AGENT" }, now).catch((e) => this.failed(e));

    res.on("finish", () => {
      const signal = this.signalFor(req, res, authenticated);
      const at = this.clock.now().getTime();
      if (signal) void detector.record(ip, signal, at).catch((e) => this.failed(e));
      else if (authenticated && res.statusCode < 400)
        void detector.recordAuthenticatedOk(ip, at).catch((e) => this.failed(e));
    });
    next();
  }

  /** What a finished request says about its sender (if anything). */
  private signalFor(req: Request, res: Response, authenticated: boolean): Signal | null {
    const path = req.path;
    if (HONEYPOT.test(req.originalUrl.split("?")[0] ?? path)) return { type: "HONEYPOT" };
    const status = res.statusCode;
    if (status === 429) return authenticated ? null : { type: "THROTTLED_HIT" };
    if (authenticated) return null; // a signed-in person making mistakes is not an attack
    if (status === 401 || status === 403) {
      if (AUTH_PATH.test(path)) {
        const username = (req.body as { username?: unknown } | undefined)?.username;
        return {
          type: "LOGIN_FAILURE",
          username: typeof username === "string" ? username.slice(0, 80) : undefined,
        };
      }
      return { type: "UNAUTHORIZED" };
    }
    if (status === 404) return { type: "NOT_FOUND", path: normalizePath(path) };
    if (status === 400 || status === 413 || status === 414 || status === 415 || status === 431)
      return { type: "BAD_REQUEST" };
    return null;
  }

  /** A verified access token (signature and expiry): the caller is a signed-in person, not an anonymous client. */
  private async hasValidToken(req: Request): Promise<boolean> {
    const header = req.get("authorization");
    const match = header ? /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/u.exec(header) : null;
    if (!match) return false;
    try {
      await this.tokens.verifyAccess(match[1]!);
      return true;
    } catch {
      return false;
    }
  }

  private failed(error: unknown): void {
    this.logger.error(JSON.stringify({ event: "security.judgement_failed", error: String(error) }));
  }

  private logBlocked(ip: string, reason: string, now: number): void {
    const last = this.lastBlockedLog.get(ip) ?? 0;
    if (now - last < 60_000) return;
    if (this.lastBlockedLog.size > 5000) this.lastBlockedLog.clear();
    this.lastBlockedLog.set(ip, now);
    this.logger.warn(JSON.stringify({ event: "security.request_refused", ip, reason }));
  }
}
