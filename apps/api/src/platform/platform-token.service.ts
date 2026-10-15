import { Inject, Injectable } from "@nestjs/common";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { unauthorized } from "../common/api-error";
import { Clock } from "../common/clock";
import { APP_CONFIG, type AppConfig } from "../common/config";

const ISSUER = "timekeeper";
/** A different audience from the tenant tokens: a Super Admin token is refused by the tenant routes and the other way round. */
const AUDIENCE = "timekeeper-platform";
const CHALLENGE_TTL_SECONDS = 300;

const accessClaims = z.object({
  sub: z.string().uuid(),
  sid: z.string().uuid(),
  typ: z.literal("platform"),
});
const challengeClaims = z.object({ sub: z.string().uuid(), purpose: z.literal("platform-mfa") });

@Injectable()
export class PlatformTokenService {
  private readonly secret: Uint8Array;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  async signAccess(
    userId: string,
    sessionId: string,
  ): Promise<{ token: string; expiresIn: number }> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const expiresIn = this.config.PLATFORM_SESSION_MINUTES * 60;
    const token = await new SignJWT({ typ: "platform", sid: sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + expiresIn)
      .sign(this.secret);
    return { token, expiresIn };
  }

  async verifyAccess(token: string): Promise<{ userId: string; sessionId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
        currentDate: this.clock.now(),
      });
      const claims = accessClaims.parse(payload);
      return { userId: claims.sub, sessionId: claims.sid };
    } catch {
      throw unauthorized("Invalid or expired platform session.");
    }
  }

  async signChallenge(userId: string): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ purpose: "platform-mfa" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + CHALLENGE_TTL_SECONDS)
      .sign(this.secret);
  }

  async verifyChallenge(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
        currentDate: this.clock.now(),
      });
      return challengeClaims.parse(payload).sub;
    } catch {
      throw unauthorized("The login challenge is invalid or has expired. Sign in again.");
    }
  }
}
