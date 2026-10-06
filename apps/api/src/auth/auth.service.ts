import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { Clock } from "../common/clock";
import { ApiError, invalidCredentials, unauthorized } from "../common/api-error";
import { type Db, DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { PasswordService } from "./password.service";
import { SecretBox } from "./secret-box";
import { SessionService } from "./session.service";
import { tenantIdFromRefreshToken, hashRefreshToken, TokenService } from "./token.service";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";
import { requiresTotp } from "./roles";
import {
  type AuthContext,
  type AuthTokens,
  type RequestMeta,
  type UserRow,
  USER_COLUMNS,
} from "./auth.types";

export type LoginResult =
  { status: "OK"; tokens: AuthTokens } | { status: "MFA_REQUIRED"; challengeToken: string };

const TOTP_ISSUER = "Timekeeper Work";
const RECOVERY_CODE_COUNT = 8;

type Outcome<T> =
  { kind: "ok"; value: T } | { kind: "fail"; error: ApiError; dummyVerify?: boolean };

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly box: SecretBox,
  ) {}

  // ---------------------------------------------------------------- login (password step)

  async login(
    input: { orgCode: string; username: string; password: string },
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const tenantId = await this.db.resolveTenant(input.orgCode);
    if (!tenantId) {
      await this.passwords.verifyDummy(input.password);
      throw invalidCredentials();
    }

    const outcome = await this.db.withTenant<Outcome<LoginResult>>(tenantId, async (tx) => {
      const user = await this.findUserForUpdate(tx, input.username);
      if (!user || user.status !== "ACTIVE") {
        return { kind: "fail", error: invalidCredentials(), dummyVerify: true };
      }

      const locked = this.lockError(user);
      if (locked) {
        await this.auditEvent(tx, user, "auth.login_blocked", meta, { reason: "ACCOUNT_LOCKED" });
        return { kind: "fail", error: locked };
      }

      if (!(await this.passwords.verify(user.password_hash, input.password))) {
        return { kind: "fail", error: await this.registerFailure(tx, user, "password", meta) };
      }

      await this.clearFailures(tx, user.id);
      if (requiresTotp(user.role) && user.totp_enabled) {
        return {
          kind: "ok",
          value: {
            status: "MFA_REQUIRED",
            challengeToken: await this.tokens.signChallenge(user.id, tenantId),
          },
        };
      }
      const tokens = await this.sessions.issue(tx, user);
      await this.auditEvent(tx, user, "auth.login_success", meta, { method: "password" });
      return { kind: "ok", value: { status: "OK", tokens } };
    });

    if (outcome.kind === "fail") {
      // No real password check happened (unknown or disabled account): spend the same time.
      if (outcome.dummyVerify) await this.passwords.verifyDummy(input.password);
      throw outcome.error;
    }
    return outcome.value;
  }

  // ---------------------------------------------------------------- login (TOTP / recovery step)

  async verifyMfa(
    input: { challengeToken: string; code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ): Promise<AuthTokens> {
    const { userId, tenantId } = await this.tokens.verifyChallenge(input.challengeToken);

    const outcome = await this.db.withTenant<Outcome<AuthTokens>>(tenantId, async (tx) => {
      const user = await this.findUserById(tx, userId, true);
      if (!user || user.status !== "ACTIVE" || !user.totp_enabled || !user.totp_secret_enc) {
        return {
          kind: "fail",
          error: unauthorized("The login challenge is no longer valid. Sign in again."),
        };
      }
      const locked = this.lockError(user);
      if (locked) return { kind: "fail", error: locked };

      let method: "totp" | "recovery" | null = null;
      if (input.code !== undefined) {
        const lastStep = user.totp_last_step === null ? null : Number(user.totp_last_step);
        const step = verifyTotp(
          this.box.decrypt(user.totp_secret_enc),
          input.code,
          this.clock.now().getTime(),
          lastStep,
        );
        if (step !== null) {
          await tx.query("UPDATE user_account SET totp_last_step = $2 WHERE id = $1", [
            user.id,
            step,
          ]);
          method = "totp";
        }
      } else if (input.recoveryCode !== undefined) {
        const used = await tx.query(
          `UPDATE user_recovery_code SET used_at = $3
            WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
          [user.id, this.box.hmac(normalizeRecoveryCode(input.recoveryCode)), this.clock.now()],
        );
        if (used.rowCount === 1) {
          method = "recovery";
          await this.auditEvent(tx, user, "auth.recovery_code_used", meta);
        }
      }

      if (method === null) {
        return { kind: "fail", error: await this.registerFailure(tx, user, "totp", meta) };
      }
      await this.clearFailures(tx, user.id);
      const tokens = await this.sessions.issue(tx, user);
      await this.auditEvent(tx, user, "auth.login_success", meta, { method });
      return { kind: "ok", value: tokens };
    });

    if (outcome.kind === "fail") throw outcome.error;
    return outcome.value;
  }

  // ---------------------------------------------------------------- refresh / logout

  /** Rotates the refresh token. Presenting an already-used token revokes the whole token family. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const tenantId = tenantIdFromRefreshToken(refreshToken);
    if (!tenantId) throw unauthorized("Invalid refresh token.");

    type SessionRow = {
      id: string;
      user_id: string;
      family_id: string;
      revoked_at: Date | null;
      expires_at: Date;
    };
    const outcome = await this.db.withTenant<Outcome<AuthTokens>>(tenantId, async (tx) => {
      const found = await tx.query<SessionRow>(
        `SELECT id, user_id, family_id, revoked_at, expires_at FROM auth_session
          WHERE refresh_hash = $1 FOR UPDATE`,
        [hashRefreshToken(refreshToken)],
      );
      const session = found.rows[0];
      const invalid = unauthorized("Invalid refresh token.");
      if (!session) return { kind: "fail", error: invalid };

      const user = await this.findUserById(tx, session.user_id, false);
      if (session.revoked_at) {
        await this.sessions.revokeFamily(tx, session.family_id);
        if (user) await this.auditEvent(tx, user, "auth.refresh_token_reuse_detected", meta);
        return { kind: "fail", error: invalid };
      }
      if (session.expires_at <= this.clock.now() || !user || user.status !== "ACTIVE") {
        return { kind: "fail", error: invalid };
      }

      await this.sessions.revoke(tx, session.id);
      return { kind: "ok", value: await this.sessions.issue(tx, user, session.family_id) };
    });

    if (outcome.kind === "fail") throw outcome.error;
    return outcome.value;
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      await this.sessions.revoke(tx, auth.sessionId);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "auth.logout",
        actorUserId: auth.userId,
        actorRole: auth.role,
        ...meta,
      });
    });
  }

  // ---------------------------------------------------------------- account

  async me(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const user = await this.findUserById(tx, auth.userId, false);
      if (!user) throw unauthorized();
      return {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        totpEnabled: user.totp_enabled,
        requires: auth.limited,
      };
    });
  }

  async changePassword(
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<AuthTokens> {
    const outcome = await this.db.withTenant<Outcome<AuthTokens>>(auth.tenantId, async (tx) => {
      const user = await this.findUserById(tx, auth.userId, true);
      if (!user) return { kind: "fail", error: unauthorized() };
      const locked = this.lockError(user);
      if (locked) return { kind: "fail", error: locked };

      if (!(await this.passwords.verify(user.password_hash, input.currentPassword))) {
        return {
          kind: "fail",
          error: await this.registerFailure(tx, user, "password_change", meta),
        };
      }
      if (input.newPassword === input.currentPassword) {
        return {
          kind: "fail",
          error: new ApiError(
            400,
            "WEAK_PASSWORD",
            "The new password must differ from the current one.",
            {
              reasons: ["SAME_AS_CURRENT"],
            },
          ),
        };
      }
      this.passwords.assertAcceptable(input.newPassword, { username: user.username });

      await tx.query(
        `UPDATE user_account
            SET password_hash = $2, must_change_password = false, password_changed_at = $3,
                failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [user.id, await this.passwords.hash(input.newPassword), this.clock.now()],
      );
      // Every existing session ends; the caller continues with a fresh one.
      await this.sessions.revokeAllForUser(tx, user.id);
      await this.auditEvent(tx, user, "auth.password_changed", meta);
      const fresh = await this.findUserById(tx, user.id, false);
      return { kind: "ok", value: await this.sessions.issue(tx, fresh!) };
    });
    if (outcome.kind === "fail") throw outcome.error;
    return outcome.value;
  }

  // ---------------------------------------------------------------- authenticator app (TOTP)

  /** Starts (or restarts) enrolment. The seed is stored encrypted and is inactive until confirmed. */
  async totpSetup(
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<{ secret: string; otpauthUri: string }> {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const user = await this.findUserById(tx, auth.userId, true);
      if (!user) throw unauthorized();
      if (user.totp_enabled) {
        throw new ApiError(
          409,
          "TOTP_ALREADY_ENABLED",
          "Two-step login is already set up for this account.",
        );
      }
      const secret = generateTotpSecret();
      await tx.query(
        "UPDATE user_account SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1",
        [user.id, this.box.encrypt(secret)],
      );
      await this.auditEvent(tx, user, "auth.totp_setup_started", meta);
      return {
        secret,
        otpauthUri: otpauthUri({ secret, issuer: TOTP_ISSUER, account: user.username }),
      };
    });
  }

  /** Confirms enrolment with a code, returns recovery codes (shown once) and a fresh session. */
  async totpEnable(
    auth: AuthContext,
    code: string,
    meta: RequestMeta,
  ): Promise<{ tokens: AuthTokens; recoveryCodes: string[] }> {
    const outcome = await this.db.withTenant<
      Outcome<{ tokens: AuthTokens; recoveryCodes: string[] }>
    >(auth.tenantId, async (tx) => {
      const user = await this.findUserById(tx, auth.userId, true);
      if (!user) return { kind: "fail", error: unauthorized() };
      if (user.totp_enabled) {
        return {
          kind: "fail",
          error: new ApiError(409, "TOTP_ALREADY_ENABLED", "Two-step login is already enabled."),
        };
      }
      if (!user.totp_secret_enc) {
        return {
          kind: "fail",
          error: new ApiError(409, "TOTP_NOT_STARTED", "Start the setup first."),
        };
      }
      const locked = this.lockError(user);
      if (locked) return { kind: "fail", error: locked };

      const step = verifyTotp(
        this.box.decrypt(user.totp_secret_enc),
        code,
        this.clock.now().getTime(),
        null,
      );
      if (step === null) {
        return { kind: "fail", error: await this.registerFailure(tx, user, "totp_enable", meta) };
      }

      await tx.query(
        "UPDATE user_account SET totp_enabled = true, totp_last_step = $2 WHERE id = $1",
        [user.id, step],
      );
      const recoveryCodes = await this.replaceRecoveryCodes(tx, user);
      await this.sessions.revokeAllForUser(tx, user.id);
      await this.auditEvent(tx, user, "auth.totp_enabled", meta);
      const fresh = await this.findUserById(tx, user.id, false);
      return {
        kind: "ok",
        value: { tokens: await this.sessions.issue(tx, fresh!), recoveryCodes },
      };
    });
    if (outcome.kind === "fail") throw outcome.error;
    return outcome.value;
  }

  // ---------------------------------------------------------------- helpers

  private async replaceRecoveryCodes(tx: Db, user: UserRow): Promise<string[]> {
    await tx.query("DELETE FROM user_recovery_code WHERE user_id = $1", [user.id]);
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
      const raw = randomBytes(10).toString("hex").toUpperCase(); // 80 bits
      codes.push(raw.match(/.{4}/gu)!.join("-"));
    }
    for (const code of codes) {
      await tx.query(
        "INSERT INTO user_recovery_code (tenant_id, user_id, code_hash) VALUES ($1, $2, $3)",
        [user.tenant_id, user.id, this.box.hmac(normalizeRecoveryCode(code))],
      );
    }
    return codes;
  }

  private lockError(user: UserRow): ApiError | null {
    if (user.locked_until && user.locked_until > this.clock.now()) {
      const retryAfterSeconds = Math.ceil(
        (user.locked_until.getTime() - this.clock.now().getTime()) / 1000,
      );
      return new ApiError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.", {
        retryAfterSeconds,
      });
    }
    return null;
  }

  /** Counts a failed attempt; the Nth consecutive failure locks the account for a while (PRD 15.2). */
  private async registerFailure(
    tx: Db,
    user: UserRow,
    step: string,
    meta: RequestMeta,
  ): Promise<ApiError> {
    const failures = user.failed_login_count + 1;
    const lock = failures >= this.config.LOGIN_MAX_FAILURES;
    const lockedUntil = lock
      ? new Date(this.clock.now().getTime() + this.config.LOGIN_LOCK_MINUTES * 60_000)
      : null;
    await tx.query(
      "UPDATE user_account SET failed_login_count = $2, locked_until = $3 WHERE id = $1",
      [user.id, lock ? 0 : failures, lockedUntil],
    );
    await this.auditEvent(tx, user, lock ? "auth.account_locked" : "auth.login_failed", meta, {
      step,
    });
    if (lock) {
      return new ApiError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.", {
        retryAfterSeconds: this.config.LOGIN_LOCK_MINUTES * 60,
      });
    }
    return step === "password"
      ? invalidCredentials()
      : new ApiError(401, "INVALID_CODE", "The code is not valid.");
  }

  private async clearFailures(tx: Db, userId: string): Promise<void> {
    await tx.query(
      "UPDATE user_account SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1",
      [userId, this.clock.now()],
    );
  }

  private auditEvent(
    tx: Db,
    user: UserRow,
    action: string,
    meta: RequestMeta,
    details?: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(tx, {
      tenantId: user.tenant_id,
      action,
      actorUserId: user.id,
      actorRole: user.role,
      entityType: "user_account",
      entityId: user.id,
      after: details,
      ...meta,
    });
  }

  private async findUserForUpdate(tx: Db, username: string): Promise<UserRow | undefined> {
    const { rows } = await tx.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM user_account WHERE lower(username) = lower($1) FOR UPDATE`,
      [username],
    );
    return rows[0];
  }

  private async findUserById(tx: Db, id: string, lock: boolean): Promise<UserRow | undefined> {
    const { rows } = await tx.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM user_account WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    );
    return rows[0];
  }
}

export const normalizeRecoveryCode = (code: string): string =>
  code.replace(/[\s-]/gu, "").toUpperCase();
