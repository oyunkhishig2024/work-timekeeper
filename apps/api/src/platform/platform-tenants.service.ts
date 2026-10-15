import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { AuditService } from "../audit/audit.service";
import type { RequestMeta } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { DatabaseService, type Db } from "../database/database.service";
import { UsersService } from "../users/users.service";
import type { PlatformContext } from "./platform.types";

const ACTOR_ROLE = "SUPER_ADMIN";
/** Codes that would look like part of the product's own addresses. */
const RESERVED_CODES = new Set([
  "platform",
  "admin",
  "api",
  "www",
  "app",
  "login",
  "setup",
  "system",
]);

export interface TenantRow {
  id: string;
  code: string;
  name: string;
  timeZone: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
}

export interface TenantStats {
  employees: number;
  staffAccounts: number;
  lastLoginAt: Date | null;
  lastEventAt: Date | null;
}

/**
 * What the Super Admin can do with organizations (PRD 4): create one with its first Organization Admin, rename, suspend and
 * reactivate, add another Organization Admin and reset one's password or authenticator. Only counts and account names are shown:
 * attendance data of an organization is not readable here (PRD 15.2, support access needs the organization's own grant).
 */
@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly users: UsersService,
  ) {}

  async list(): Promise<Array<TenantRow & TenantStats>> {
    const tenants = await this.db.asPlatform(async (tx) => {
      const { rows } = await tx.query<TenantRow>(
        `SELECT id, code, name, time_zone AS "timeZone", status, created_at AS "createdAt"
           FROM tenant ORDER BY created_at, code`,
      );
      return rows;
    });
    return Promise.all(tenants.map(async (t) => ({ ...t, ...(await this.stats(t.id)) })));
  }

  async get(id: string) {
    const tenant = await this.load(id);
    const [stats, admins] = await Promise.all([this.stats(id), this.admins(id)]);
    return { ...tenant, ...stats, admins };
  }

  async create(
    ctx: PlatformContext,
    input: {
      code: string;
      name: string;
      timeZone: string;
      adminUsername: string;
      adminDisplayName: string;
    },
    meta: RequestMeta,
  ) {
    if (RESERVED_CODES.has(input.code)) {
      throw new ApiError(
        409,
        "CODE_RESERVED",
        "That organization code is reserved. Choose another.",
      );
    }
    if (!isTimeZone(input.timeZone)) {
      throw new ApiError(400, "INVALID_TIME_ZONE", "Unknown time zone.");
    }
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    // One transaction: the organization, its defaults, its first Organization Admin and the audit rows commit together or not at all.
    const tenantId = await this.db.asPlatform(async (tx) => {
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          "INSERT INTO tenant (code, name, time_zone) VALUES ($1, $2, $3) RETURNING id",
          [input.code, input.name, input.timeZone],
        );
        id = rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ApiError(409, "CODE_TAKEN", "That organization code is already used.");
        }
        throw error;
      }
      await this.audit.record(tx, {
        tenantId: id,
        action: "tenant.created",
        actorUserId: ctx.userId,
        actorRole: ACTOR_ROLE,
        entityType: "tenant",
        entityId: id,
        after: { code: input.code, name: input.name, timeZone: input.timeZone },
        ...meta,
      });
      // Continue as the new organization's own session (app_user + tenant) to write its defaults and first admin.
      await tx.query("SET LOCAL ROLE app_user");
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await seedDefaults(tx, id);
      const admin = await tx.query<{ id: string }>(
        `INSERT INTO user_account (tenant_id, username, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'ORG_ADMIN') RETURNING id`,
        [id, input.adminUsername, input.adminDisplayName, passwordHash],
      );
      await this.audit.record(tx, {
        tenantId: id,
        action: "user.created",
        actorUserId: ctx.userId,
        actorRole: ACTOR_ROLE,
        entityType: "user_account",
        entityId: admin.rows[0]!.id,
        after: { username: input.adminUsername, role: "ORG_ADMIN" },
        ...meta,
      });
      return id;
    });
    return {
      tenant: await this.get(tenantId),
      admin: { username: input.adminUsername, temporaryPassword },
    };
  }

  async rename(ctx: PlatformContext, id: string, name: string, meta: RequestMeta) {
    await this.db.asPlatform(async (tx) => {
      const before = await this.lock(tx, id);
      await tx.query("UPDATE tenant SET name = $2 WHERE id = $1", [id, name]);
      await this.audit.record(tx, {
        tenantId: id,
        action: "tenant.renamed",
        actorUserId: ctx.userId,
        actorRole: ACTOR_ROLE,
        entityType: "tenant",
        entityId: id,
        before: { name: before.name },
        after: { name },
        ...meta,
      });
    });
    return this.get(id);
  }

  /** A suspended organization cannot sign in and its live sessions stop working at once; nothing is deleted. */
  async setStatus(
    ctx: PlatformContext,
    id: string,
    status: "ACTIVE" | "SUSPENDED",
    meta: RequestMeta,
  ) {
    await this.db.asPlatform(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status === status) {
        throw new ApiError(
          409,
          "NO_CHANGE",
          status === "SUSPENDED"
            ? "The organization is already suspended."
            : "The organization is already active.",
        );
      }
      await tx.query("UPDATE tenant SET status = $2 WHERE id = $1", [id, status]);
      await this.audit.record(tx, {
        tenantId: id,
        action: status === "SUSPENDED" ? "tenant.suspended" : "tenant.activated",
        actorUserId: ctx.userId,
        actorRole: ACTOR_ROLE,
        entityType: "tenant",
        entityId: id,
        ...meta,
      });
    });
    return this.get(id);
  }

  async addAdmin(
    ctx: PlatformContext,
    id: string,
    input: { username: string; displayName: string },
    meta: RequestMeta,
  ) {
    await this.load(id);
    const created = await this.users.create(
      id,
      { username: input.username, displayName: input.displayName, role: "ORG_ADMIN" },
      { userId: ctx.userId, role: ACTOR_ROLE },
      meta,
    );
    return { username: created.username, temporaryPassword: created.temporaryPassword };
  }

  /** New one-time password (and, with `totp`, no authenticator) for an Organization Admin who is locked out. */
  async resetAdmin(
    ctx: PlatformContext,
    id: string,
    username: string,
    options: { totp: boolean },
    meta: RequestMeta,
  ) {
    await this.load(id);
    const admins = await this.admins(id);
    if (!admins.some((a) => a.username.toLowerCase() === username.toLowerCase())) {
      throw new ApiError(
        404,
        "USER_NOT_FOUND",
        "That is not an Organization Admin of this organization.",
      );
    }
    const result = await this.users.resetFromConsole(id, username, options, meta, {
      userId: ctx.userId,
      role: ACTOR_ROLE,
    });
    return {
      username: result.username,
      temporaryPassword: result.temporaryPassword,
      totpRemoved: result.totpRemoved,
    };
  }

  /** The Super Admin's own trail: sign-ins and every organization action. */
  async activity(limit: number) {
    return this.db.asPlatform(async (tx) => {
      const { rows } = await tx.query(
        `SELECT a.id, a.occurred_at AS "occurredAt", a.action, a.actor_role AS "actorRole",
                p.username AS "actorUsername", t.code AS "orgCode", a.after AS details
           FROM audit_log a
           LEFT JOIN platform_user p ON p.id = a.actor_user_id AND a.actor_role = 'SUPER_ADMIN'
           LEFT JOIN tenant t ON t.id = a.tenant_id
          WHERE a.actor_role = 'SUPER_ADMIN' OR a.action LIKE 'platform.%'
          ORDER BY a.id DESC LIMIT $1`,
        [limit],
      );
      return rows;
    });
  }

  // ------------------------------------------------------------------ helpers

  private async load(id: string): Promise<TenantRow> {
    return this.db.asPlatform(async (tx) => {
      const { rows } = await tx.query<TenantRow>(
        `SELECT id, code, name, time_zone AS "timeZone", status, created_at AS "createdAt" FROM tenant WHERE id = $1`,
        [id],
      );
      if (!rows[0]) throw new ApiError(404, "TENANT_NOT_FOUND", "Organization not found.");
      return rows[0];
    });
  }

  private async lock(tx: Db, id: string): Promise<TenantRow> {
    const { rows } = await tx.query<TenantRow>(
      `SELECT id, code, name, time_zone AS "timeZone", status, created_at AS "createdAt" FROM tenant WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw new ApiError(404, "TENANT_NOT_FOUND", "Organization not found.");
    return rows[0];
  }

  /** Counts only: how big the organization is and when it was last used. */
  private stats(id: string): Promise<TenantStats> {
    return this.db.withTenant(id, async (tx) => {
      const { rows } = await tx.query<TenantStats>(
        `SELECT (SELECT count(*)::int FROM employee WHERE status = 'ACTIVE') AS employees,
                (SELECT count(*)::int FROM user_account WHERE role <> 'EMPLOYEE' AND status = 'ACTIVE') AS "staffAccounts",
                (SELECT max(last_login_at) FROM user_account) AS "lastLoginAt",
                (SELECT max(received_at) FROM device_event) AS "lastEventAt"`,
      );
      return rows[0]!;
    });
  }

  private admins(id: string) {
    return this.db.withTenant(id, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        username: string;
        displayName: string | null;
        status: string;
        totpEnabled: boolean;
        lastLoginAt: Date | null;
      }>(
        `SELECT id, username, display_name AS "displayName", status, totp_enabled AS "totpEnabled",
                last_login_at AS "lastLoginAt"
           FROM user_account WHERE role = 'ORG_ADMIN' ORDER BY username`,
      );
      return rows;
    });
  }
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * What a new organization starts with (the same as infra/deploy/baseline-310.sql): the 15 predefined absence reasons, default
 * settings, a DRAFT consent text, attendance rules (grace 15 min, minimum stay 3 min) and a Monday-Friday 08:30-17:30 week.
 * Runs inside the new organization's own session.
 */
async function seedDefaults(tx: Db, tenantId: string): Promise<void> {
  await tx.query("SELECT seed_default_reasons($1)", [tenantId]);
  await tx.query(
    `INSERT INTO tenant_setting (tenant_id, key, value) VALUES
       ($1, 'anomaly_mode', '"accept_and_flag"'), ($1, 'correction_approval', '"off"'), ($1, 'accuracy_threshold_m', '50')`,
    [tenantId],
  );
  await tx.query(
    `INSERT INTO consent_text_version (tenant_id, version, body, is_draft, active)
     VALUES ($1, 'consent-v1-draft',
             'DRAFT - replace with the legally reviewed text (docs/Timekeeper_Work_PRD.md, Appendix A).', true, true)`,
    [tenantId],
  );
  await tx.query(
    "INSERT INTO attendance_rule_version (tenant_id, valid_from) VALUES ($1, DATE '2026-01-01')",
    [tenantId],
  );
  await tx.query(
    `WITH v AS (
       INSERT INTO working_week_version (tenant_id, valid_from) VALUES ($1, DATE '2026-01-01') RETURNING id
     )
     INSERT INTO working_week_day (tenant_id, working_week_id, weekday, working, start_time, end_time)
     SELECT $1, v.id, d, d <= 5, CASE WHEN d <= 5 THEN TIME '08:30' END, CASE WHEN d <= 5 THEN TIME '17:30' END
       FROM v, generate_series(1, 7) AS d`,
    [tenantId],
  );
}
