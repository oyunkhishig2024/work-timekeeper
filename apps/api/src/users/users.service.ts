import { Injectable } from "@nestjs/common";
import { ApiError, forbidden } from "../common/api-error";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { canManageRole, type Role } from "../auth/roles";
import { SessionService } from "../auth/session.service";

export interface CreatedUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** Shown once. The user must change it at first login. */
  temporaryPassword: string;
}

interface Actor {
  userId: string | null;
  role: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  /** Used by the API (Org Admin creates HR/Manager) and by the bootstrap CLI. */
  async create(
    tenantId: string,
    input: { username: string; displayName: string; role: Exclude<Role, "EMPLOYEE"> },
    actor: Actor,
    meta: RequestMeta,
  ): Promise<CreatedUser> {
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    return this.db.withTenant(tenantId, async (tx) => {
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO user_account (tenant_id, username, display_name, password_hash, role)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [tenantId, input.username, input.displayName, passwordHash, input.role],
        );
        id = rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ApiError(409, "USERNAME_TAKEN", "That username is already in use.");
        }
        throw error;
      }
      await this.audit.record(tx, {
        tenantId,
        action: "user.created",
        actorUserId: actor.userId,
        actorRole: actor.role,
        entityType: "user_account",
        entityId: id,
        after: { username: input.username, role: input.role },
        ...meta,
      });
      return {
        id,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        temporaryPassword,
      };
    });
  }

  /** Staff accounts of the tenant (employee logins are managed through the employees API). */
  async list(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.id, u.username, u.display_name AS "displayName", u.role, u.status,
                u.totp_enabled AS "totpEnabled", u.must_change_password AS "mustChangePassword",
                u.last_login_at AS "lastLoginAt",
                (SELECT count(*)::int FROM user_scope s WHERE s.user_id = u.id) AS "scopeRules"
           FROM user_account u WHERE u.role <> 'EMPLOYEE' ORDER BY u.username`,
      );
      return rows;
    });
  }

  async getScope(auth: AuthContext, userId: string) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      await this.loadScopable(tx, userId);
      return this.readScope(tx, userId);
    });
  }

  /**
   * Replaces the locations and departments a Manager (or scoped HR) may see (PRD 4). A Manager with no scope
   * sees nothing; an HR user with no scope sees everything.
   */
  async setScope(
    auth: AuthContext,
    userId: string,
    input: { locationIds: string[]; departmentIds: string[] },
    meta: RequestMeta,
  ) {
    const locationIds = [...new Set(input.locationIds)];
    const departmentIds = [...new Set(input.departmentIds)];
    return this.db.withTenant(auth.tenantId, async (tx) => {
      await this.loadScopable(tx, userId);
      const locations = await tx.query("SELECT 1 FROM location WHERE id = ANY($1::uuid[])", [
        locationIds,
      ]);
      const departments = await tx.query("SELECT 1 FROM department WHERE id = ANY($1::uuid[])", [
        departmentIds,
      ]);
      if (locations.rowCount !== locationIds.length) {
        throw new ApiError(400, "LOCATION_NOT_FOUND", "Some locations do not exist.");
      }
      if (departments.rowCount !== departmentIds.length) {
        throw new ApiError(400, "DEPARTMENT_NOT_FOUND", "Some departments do not exist.");
      }
      const before = await this.readScope(tx, userId);
      await tx.query("DELETE FROM user_scope WHERE user_id = $1", [userId]);
      for (const locationId of locationIds) {
        await tx.query(
          "INSERT INTO user_scope (tenant_id, user_id, location_id) VALUES ($1, $2, $3)",
          [auth.tenantId, userId, locationId],
        );
      }
      for (const departmentId of departmentIds) {
        await tx.query(
          "INSERT INTO user_scope (tenant_id, user_id, department_id) VALUES ($1, $2, $3)",
          [auth.tenantId, userId, departmentId],
        );
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "user.scope_set",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "user_account",
        entityId: userId,
        before,
        after: { locationIds, departmentIds },
        ...meta,
      });
      return { locationIds, departmentIds };
    });
  }

  private async readScope(tx: Db, userId: string) {
    const { rows } = await tx.query<{ location_id: string | null; department_id: string | null }>(
      "SELECT location_id, department_id FROM user_scope WHERE user_id = $1",
      [userId],
    );
    return {
      locationIds: rows.flatMap((r) => (r.location_id ? [r.location_id] : [])),
      departmentIds: rows.flatMap((r) => (r.department_id ? [r.department_id] : [])),
    };
  }

  /** Only HR and Manager accounts have a configurable scope (Org Admin sees everything). */
  private async loadScopable(tx: Db, userId: string): Promise<void> {
    const { rows } = await tx.query<{ role: Role }>("SELECT role FROM user_account WHERE id = $1", [
      userId,
    ]);
    if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
    if (rows[0].role !== "HR" && rows[0].role !== "MANAGER") {
      throw new ApiError(
        409,
        "SCOPE_NOT_APPLICABLE",
        "Only HR and Manager accounts have a data scope.",
      );
    }
  }

  /** HR-assisted / admin password reset: new one-time password, all sessions revoked (PRD 15.2). */
  async resetPassword(
    auth: AuthContext,
    targetId: string,
    meta: RequestMeta,
  ): Promise<{ id: string; temporaryPassword: string }> {
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const target = await this.loadManageable(tx, auth, targetId);
      await tx.query(
        `UPDATE user_account
            SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [target.id, passwordHash],
      );
      await this.sessions.revokeAllForUser(tx, target.id);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "user.password_reset",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "user_account",
        entityId: target.id,
        ...meta,
      });
      return { id: target.id, temporaryPassword };
    });
  }

  /** Removes a user's authenticator (lost phone). They must set it up again at next login. */
  async resetTotp(auth: AuthContext, targetId: string, meta: RequestMeta): Promise<{ id: string }> {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const target = await this.loadManageable(tx, auth, targetId);
      await tx.query(
        `UPDATE user_account
            SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL
          WHERE id = $1`,
        [target.id],
      );
      await tx.query("DELETE FROM user_recovery_code WHERE user_id = $1", [target.id]);
      await this.sessions.revokeAllForUser(tx, target.id);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "user.totp_reset",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "user_account",
        entityId: target.id,
        ...meta,
      });
      return { id: target.id };
    });
  }

  private async loadManageable(
    tx: Db,
    auth: AuthContext,
    targetId: string,
  ): Promise<{ id: string; role: Role }> {
    const { rows } = await tx.query<{ id: string; role: Role }>(
      "SELECT id, role FROM user_account WHERE id = $1 FOR UPDATE",
      [targetId],
    );
    const target = rows[0];
    if (!target) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
    if (target.id === auth.userId) {
      throw forbidden("Use the account settings to change your own credentials.");
    }
    if (!canManageRole(auth.role, target.role)) throw forbidden();
    return target;
  }
}
