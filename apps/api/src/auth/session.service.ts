import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { Clock } from "../common/clock";
import type { Db } from "../database/database.service";
import type { AccessClaims, LimitReason } from "./token.service";
import { newRefreshToken, TokenService } from "./token.service";
import { requiresTotp } from "./roles";
import type { AuthTokens, UserRow } from "./auth.types";

/** Session = one refresh-token record. Tokens rotate on every refresh and belong to a "family". */
@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly tokens: TokenService,
  ) {}

  limitsFor(user: Pick<UserRow, "role" | "must_change_password" | "totp_enabled">): LimitReason[] {
    const limits: LimitReason[] = [];
    if (user.must_change_password) limits.push("PASSWORD_CHANGE");
    if (requiresTotp(user.role) && !user.totp_enabled) limits.push("TOTP_SETUP");
    return limits;
  }

  /** Creates a session (new family unless `familyId` is given on rotation) and signs tokens. */
  async issue(db: Db, user: UserRow, familyId?: string): Promise<AuthTokens> {
    const now = this.clock.now();
    const lifetimeMs =
      user.role === "EMPLOYEE"
        ? this.config.EMPLOYEE_SESSION_DAYS * 24 * 60 * 60 * 1000
        : this.config.STAFF_SESSION_IDLE_MINUTES * 60 * 1000; // sliding: renewed by every refresh
    const refresh = newRefreshToken(user.tenant_id);

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO auth_session (tenant_id, user_id, refresh_hash, expires_at, family_id, last_used_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::uuid, gen_random_uuid()), $6)
       RETURNING id`,
      [
        user.tenant_id,
        user.id,
        refresh.hash,
        new Date(now.getTime() + lifetimeMs),
        familyId ?? null,
        now,
      ],
    );
    const sessionId = rows[0]!.id;

    const limits = this.limitsFor(user);
    const claims: AccessClaims = {
      sub: user.id,
      tid: user.tenant_id,
      sid: sessionId,
      role: user.role,
      ...(limits.length > 0 ? { lim: limits } : {}),
    };
    const access = await this.tokens.signAccess(claims);
    return {
      tokenType: "Bearer",
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: refresh.token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      },
      requires: limits,
    };
  }

  /** The current state of the account behind an access token, or null if the session is no longer valid. */
  async loadLive(
    db: Db,
    claims: AccessClaims,
  ): Promise<{ role: UserRow["role"]; limited: LimitReason[] } | null> {
    const { rows } = await db.query<
      Pick<UserRow, "role" | "status" | "must_change_password" | "totp_enabled">
    >(
      `SELECT u.role, u.status, u.must_change_password, u.totp_enabled
         FROM auth_session s
         JOIN user_account u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > $3`,
      [claims.sid, claims.sub, this.clock.now()],
    );
    const user = rows[0];
    if (!user || user.status !== "ACTIVE") return null;
    // Limits come from the live account, not only from the token, so finishing a step takes effect at once.
    return { role: user.role, limited: this.limitsFor(user) };
  }

  async revoke(db: Db, sessionId: string): Promise<void> {
    await db.query("UPDATE auth_session SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
      sessionId,
      this.clock.now(),
    ]);
  }

  async revokeFamily(db: Db, familyId: string): Promise<void> {
    await db.query(
      "UPDATE auth_session SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL",
      [familyId, this.clock.now()],
    );
  }

  async revokeAllForUser(db: Db, userId: string): Promise<void> {
    await db.query(
      "UPDATE auth_session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
      [userId, this.clock.now()],
    );
  }
}
