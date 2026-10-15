import { Inject, Injectable } from "@nestjs/common";
import {
  ApiError,
  invalidCredentials,
  tempPasswordExpired,
  unauthorized,
} from "../common/api-error";
import { Clock } from "../common/clock";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { AuditService } from "../audit/audit.service";
import { DatabaseService, type Db } from "../database/database.service";
import type { RequestMeta } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { SecretBox } from "../auth/secret-box";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../auth/totp";
import { PlatformTokenService } from "./platform-token.service";
import {
  PLATFORM_USER_COLUMNS,
  type PlatformContext,
  type PlatformLimit,
  type PlatformTokens,
  type PlatformUserRow,
} from "./platform.types";

type Outcome<T> =
  { kind: "ok"; value: T } | { kind: "fail"; error: ApiError; dummyVerify?: boolean };
export type PlatformLoginResult =
  { status: "OK"; tokens: PlatformTokens } | { status: "MFA_REQUIRED"; challengeToken: string };

const TOTP_ISSUER = "Timekeeper Work (platform)";

/**
 * Sign-in of the Super Admin (platform owner). Same rules as the staff sign-in (Argon2id, lockout, one-time codes) with two
 * differences: the authenticator app is mandatory for everyone, and a session is one row with a fixed lifetime, no refresh token.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly box: SecretBox,
    private readonly tokens: PlatformTokenService,
  ) {}

  limitsFor(user: Pick<PlatformUserRow, "must_change_password" | "totp_enabled">): PlatformLimit[] {
    const limits: PlatformLimit[] = [];
    if (user.must_change_password) limits.push("PASSWORD_CHANGE");
    if (!user.totp_enabled) limits.push("TOTP_SETUP");
    return limits;
  }

  async login(
    input: { username: string; password: string },
    meta: RequestMeta,
  ): Promise<PlatformLoginResult> {
    const outcome = await this.db.asPlatform<Outcome<PlatformLoginResult>>(async (tx) => {
      const user = await this.findByUsername(tx, input.username);
      if (!user || user.status !== "ACTIVE") {
        return { kind: "fail", error: invalidCredentials(), dummyVerify: true };
      }
      const locked = this.lockError(user);
      if (locked) {
        await this.event(tx, user, "platform.login_blocked", meta, { reason: "ACCOUNT_LOCKED" });
        return { kind: "fail", error: locked };
      }
      if (!(await this.passwords.verify(user.password_hash, input.password))) {
        return { kind: "fail", error: await this.registerFailure(tx, user, "password", meta) };
      }
      if (
        user.must_change_password &&
        user.temp_password_expires_at &&
        user.temp_password_expires_at <= this.clock.now()
      ) {
        return { kind: "fail", error: tempPasswordExpired() };
      }
      await this.clearFailures(tx, user.id);
      if (user.totp_enabled) {
        return {
          kind: "ok",
          value: {
            status: "MFA_REQUIRED",
            challengeToken: await this.tokens.signChallenge(user.id),
          },
        };
      }
      const tokens = await this.issue(tx, user);
      await this.event(tx, user, "platform.login_success", meta, { method: "password" });
      return { kind: "ok", value: { status: "OK", tokens } };
    });
    if (outcome.kind === "fail") {
      if (outcome.dummyVerify) await this.passwords.verifyDummy(input.password);
      throw outcome.error;
    }
    return outcome.value;
  }

  async verifyMfa(
    input: { challengeToken: string; code: string },
    meta: RequestMeta,
  ): Promise<PlatformTokens> {
    const userId = await this.tokens.verifyChallenge(input.challengeToken);
    const outcome = await this.db.asPlatform<Outcome<PlatformTokens>>(async (tx) => {
      const user = await this.findById(tx, userId, true);
      if (!user || user.status !== "ACTIVE" || !user.totp_enabled || !user.totp_secret_enc) {
        return {
          kind: "fail",
          error: unauthorized("The login challenge is no longer valid. Sign in again."),
        };
      }
      const locked = this.lockError(user);
      if (locked) return { kind: "fail", error: locked };
      const step = verifyTotp(
        this.box.decrypt(user.totp_secret_enc),
        input.code,
        this.clock.now().getTime(),
        user.totp_last_step === null ? null : Number(user.totp_last_step),
      );
      if (step === null) {
        return { kind: "fail", error: await this.registerFailure(tx, user, "totp", meta) };
      }
      await tx.query("UPDATE platform_user SET totp_last_step = $2 WHERE id = $1", [user.id, step]);
      await this.clearFailures(tx, user.id);
      const tokens = await this.issue(tx, user);
      await this.event(tx, user, "platform.login_success", meta, { method: "totp" });
      return { kind: "ok", value: tokens };
    });
    if (outcome.kind === "fail") throw outcome.error;
    return outcome.value;
  }

  async logout(ctx: PlatformContext, meta: RequestMeta): Promise<void> {
    await this.db.asPlatform(async (tx) => {
      await tx.query(
        "UPDATE platform_session SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
        [ctx.sessionId, this.clock.now()],
      );
      await this.audit.record(tx, {
        tenantId: null,
        action: "platform.logout",
        actorUserId: ctx.userId,
        actorRole: "SUPER_ADMIN",
        entityType: "platform_user",
        entityId: ctx.userId,
        ...meta,
      });
    });
  }

  async me(ctx: PlatformContext) {
    return this.db.asPlatform(async (tx) => {
      const user = await this.findById(tx, ctx.userId, false);
      if (!user) throw unauthorized();
      return {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        totpEnabled: user.totp_enabled,
        requires: ctx.limited,
      };
    });
  }

  async changePassword(
    ctx: PlatformContext,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<PlatformTokens> {
    const outcome = await this.db.asPlatform<Outcome<PlatformTokens>>(async (tx) => {
      const user = await this.findById(tx, ctx.userId, true);
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
        `UPDATE platform_user
            SET password_hash = $2, must_change_password = false, password_changed_at = $3,
                failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [user.id, await this.passwords.hash(input.newPassword), this.clock.now()],
      );
      await this.revokeAll(tx, user.id);
      await this.event(tx, user, "platform.password_changed", meta);
      const fresh = await this.findById(tx, user.id, false);
      return { kind: "ok", value: await this.issue(tx, fresh!) };
    });
    if (outcome.kind === "fail") throw outcome.error;
    return outcome.value;
  }

  async totpSetup(
    ctx: PlatformContext,
    meta: RequestMeta,
  ): Promise<{ secret: string; otpauthUri: string }> {
    return this.db.asPlatform(async (tx) => {
      const user = await this.findById(tx, ctx.userId, true);
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
        "UPDATE platform_user SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1",
        [user.id, this.box.encrypt(secret)],
      );
      await this.event(tx, user, "platform.totp_setup_started", meta);
      return {
        secret,
        otpauthUri: otpauthUri({ secret, issuer: TOTP_ISSUER, account: user.username }),
      };
    });
  }

  async totpEnable(ctx: PlatformContext, code: string, meta: RequestMeta): Promise<PlatformTokens> {
    const outcome = await this.db.asPlatform<Outcome<PlatformTokens>>(async (tx) => {
      const user = await this.findById(tx, ctx.userId, true);
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
        "UPDATE platform_user SET totp_enabled = true, totp_last_step = $2 WHERE id = $1",
        [user.id, step],
      );
      await this.revokeAll(tx, user.id);
      await this.event(tx, user, "platform.totp_enabled", meta);
      const fresh = await this.findById(tx, user.id, false);
      return { kind: "ok", value: await this.issue(tx, fresh!) };
    });
    if (outcome.kind === "fail") throw outcome.error;
    return outcome.value;
  }

  /** The live state of a session for the guard: null when it ended, expired or the account is disabled. */
  async loadLive(
    userId: string,
    sessionId: string,
  ): Promise<{ username: string; limited: PlatformLimit[] } | null> {
    return this.db.asPlatform(async (tx) => {
      const { rows } = await tx.query<
        Pick<PlatformUserRow, "username" | "status" | "must_change_password" | "totp_enabled">
      >(
        `SELECT u.username, u.status, u.must_change_password, u.totp_enabled
           FROM platform_session s JOIN platform_user u ON u.id = s.user_id
          WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > $3`,
        [sessionId, userId, this.clock.now()],
      );
      const user = rows[0];
      if (!user || user.status !== "ACTIVE") return null;
      return { username: user.username, limited: this.limitsFor(user) };
    });
  }

  // ------------------------------------------------------------------ console tools (cli/create-platform-user.ts)

  /** Creates a Super Admin, or (reset) gives an existing one a new one-time password and removes the authenticator. */
  async createOrReset(
    input: { username: string; displayName: string | null },
    reset: boolean,
    meta: RequestMeta,
  ): Promise<{ username: string; temporaryPassword: string; created: boolean }> {
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(username)) {
      throw new ApiError(
        400,
        "INVALID_USERNAME",
        "Use 3-64 letters, digits, dot, dash or underscore.",
      );
    }
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    return this.db.asPlatform(async (tx) => {
      const existing = await this.findByUsername(tx, username);
      if (existing && !reset) {
        throw new ApiError(
          409,
          "USERNAME_TAKEN",
          `The Super Admin "${username}" already exists. Use --reset.`,
        );
      }
      if (!existing && reset)
        throw new ApiError(404, "USER_NOT_FOUND", `No Super Admin "${username}".`);
      let id: string;
      if (existing) {
        id = existing.id;
        await tx.query(
          `UPDATE platform_user
              SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL,
                  totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, status = 'ACTIVE'
            WHERE id = $1`,
          [id, passwordHash],
        );
        await this.revokeAll(tx, id);
      } else {
        const { rows } = await tx.query<{ id: string }>(
          "INSERT INTO platform_user (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
          [username, input.displayName, passwordHash],
        );
        id = rows[0]!.id;
      }
      await this.audit.record(tx, {
        tenantId: null,
        action: existing ? "platform.user_reset" : "platform.user_created",
        actorUserId: null,
        actorRole: "system:cli",
        entityType: "platform_user",
        entityId: id,
        after: { username },
        ...meta,
      });
      return { username, temporaryPassword, created: !existing };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async issue(tx: Db, user: PlatformUserRow): Promise<PlatformTokens> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.PLATFORM_SESSION_MINUTES * 60_000);
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO platform_session (user_id, expires_at) VALUES ($1, $2) RETURNING id",
      [user.id, expiresAt],
    );
    const access = await this.tokens.signAccess(user.id, rows[0]!.id);
    return {
      tokenType: "Bearer",
      accessToken: access.token,
      expiresIn: access.expiresIn,
      user: { id: user.id, username: user.username, displayName: user.display_name },
      requires: this.limitsFor(user),
    };
  }

  private revokeAll(tx: Db, userId: string): Promise<unknown> {
    return tx.query(
      "UPDATE platform_session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
      [userId, this.clock.now()],
    );
  }

  private lockError(user: PlatformUserRow): ApiError | null {
    if (user.locked_until && user.locked_until > this.clock.now()) {
      return new ApiError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.", {
        retryAfterSeconds: Math.ceil(
          (user.locked_until.getTime() - this.clock.now().getTime()) / 1000,
        ),
      });
    }
    return null;
  }

  private async registerFailure(
    tx: Db,
    user: PlatformUserRow,
    step: string,
    meta: RequestMeta,
  ): Promise<ApiError> {
    const failures = user.failed_login_count + 1;
    const lock = failures >= this.config.LOGIN_MAX_FAILURES;
    await tx.query(
      "UPDATE platform_user SET failed_login_count = $2, locked_until = $3 WHERE id = $1",
      [
        user.id,
        lock ? 0 : failures,
        lock
          ? new Date(this.clock.now().getTime() + this.config.LOGIN_LOCK_MINUTES * 60_000)
          : null,
      ],
    );
    await this.event(tx, user, lock ? "platform.account_locked" : "platform.login_failed", meta, {
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

  private clearFailures(tx: Db, userId: string): Promise<unknown> {
    return tx.query(
      "UPDATE platform_user SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1",
      [userId, this.clock.now()],
    );
  }

  private event(
    tx: Db,
    user: PlatformUserRow,
    action: string,
    meta: RequestMeta,
    details?: Record<string, unknown>,
  ) {
    return this.audit.record(tx, {
      tenantId: null,
      action,
      actorUserId: user.id,
      actorRole: "SUPER_ADMIN",
      entityType: "platform_user",
      entityId: user.id,
      after: details,
      ...meta,
    });
  }

  private async findByUsername(tx: Db, username: string): Promise<PlatformUserRow | undefined> {
    const { rows } = await tx.query<PlatformUserRow>(
      `SELECT ${PLATFORM_USER_COLUMNS} FROM platform_user WHERE lower(username) = lower($1) FOR UPDATE`,
      [username],
    );
    return rows[0];
  }

  private async findById(tx: Db, id: string, lock: boolean): Promise<PlatformUserRow | undefined> {
    const { rows } = await tx.query<PlatformUserRow>(
      `SELECT ${PLATFORM_USER_COLUMNS} FROM platform_user WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    );
    return rows[0];
  }
}
