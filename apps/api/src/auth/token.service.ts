import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { Clock } from "../common/clock";
import { unauthorized } from "../common/api-error";

const ISSUER = "timekeeper";
const AUDIENCE = "timekeeper-api";
const CHALLENGE_TTL_SECONDS = 300;

export type LimitReason = "PASSWORD_CHANGE" | "TOTP_SETUP";

const accessClaims = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  sid: z.string().uuid(),
  role: z.enum(["ORG_ADMIN", "HR", "MANAGER", "EMPLOYEE"]),
  /** Present while the user must finish a step (change password / set up TOTP) before normal use. */
  lim: z.array(z.enum(["PASSWORD_CHANGE", "TOTP_SETUP"])).optional(),
});
export type AccessClaims = z.infer<typeof accessClaims>;

const challengeClaims = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  purpose: z.literal("mfa"),
});

@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresIn: number }> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.config.ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.secret);
    return { token, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
        currentDate: this.clock.now(),
      });
      return accessClaims.parse(payload);
    } catch {
      throw unauthorized("Invalid or expired access token.");
    }
  }

  /** Short-lived proof that the password step succeeded, exchanged for tokens after the TOTP step. */
  async signChallenge(userId: string, tenantId: string): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ purpose: "mfa", tid: tenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + CHALLENGE_TTL_SECONDS)
      .sign(this.secret);
  }

  async verifyChallenge(token: string): Promise<{ userId: string; tenantId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
        currentDate: this.clock.now(),
      });
      const claims = challengeClaims.parse(payload);
      return { userId: claims.sub, tenantId: claims.tid };
    } catch {
      throw unauthorized("The login challenge is invalid or has expired. Sign in again.");
    }
  }
}

/** Refresh tokens are opaque: `<tenantId>.<32 random bytes>`; only a SHA-256 hash is stored. */
export function newRefreshToken(tenantId: string): { token: string; hash: string } {
  const token = `${tenantId}.${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashRefreshToken(token) };
}

export const hashRefreshToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export function tenantIdFromRefreshToken(token: string): string | null {
  const [tenantId] = token.split(".");
  return tenantId && /^[0-9a-f-]{36}$/u.test(tenantId) ? tenantId : null;
}

/** The same opaque, tenant-prefixed token format is used for QR codes. */
export const newTenantToken = newRefreshToken;
export const hashTenantToken = hashRefreshToken;
