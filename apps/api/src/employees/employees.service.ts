import { Injectable } from "@nestjs/common";
import { Clock } from "../common/clock";
import { ApiError, forbidden } from "../common/api-error";
import { subtractMonths, todayIn } from "../common/dates";
import { likeEscape, updateColumns } from "../common/sql";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { ScopeService, type DataScope } from "../access/scope.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { SessionService } from "../auth/session.service";
import { JobHistoryService, type AssignInput } from "./job-history.service";
import type { JobKind } from "./job-kinds";

export interface EmployeeFields {
  employeeNo: string;
  fullName: string;
  departmentId: string;
  primaryLocationId: string;
  startDate?: string | null;
  endDate?: string | null;
  scheduleMode?: "STANDARD" | "SHIFT";
  manualAttendance?: boolean;
  /** Rank (цол) / position (албан тушаал) held from the start date (create) or from today (update). */
  rankId?: string;
  positionId?: string;
}

export interface EmployeeFilter {
  q?: string;
  status: "ACTIVE" | "DISABLED" | "ARCHIVED" | "ALL";
  departmentId?: string;
  locationId?: string;
  scheduleMode?: "STANDARD" | "SHIFT";
  manualAttendance?: boolean;
  hasDevice?: boolean;
  rankId?: string;
  positionId?: string;
  consentStatus?: "NOT_REQUESTED" | "PRINTED" | "SIGNED" | "WITHDRAWN";
  sort: "employeeNo" | "fullName" | "createdAt";
  order: "asc" | "desc";
  limit: number;
  offset: number;
}

const SELECT = `
  e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.status,
  e.department_id AS "departmentId", d.name AS "departmentName",
  e.primary_location_id AS "primaryLocationId", l.name AS "locationName",
  e.start_date::text AS "startDate", e.end_date::text AS "endDate",
  e.schedule_mode AS "scheduleMode", e.manual_attendance AS "manualAttendance",
  e.device_model AS "deviceModel", e.os_version AS "osVersion", e.device_compatible AS "deviceCompatible",
  ra.job_rank_id AS "rankId", jr.name AS "rankName",
  pa.job_position_id AS "positionId", jp.name AS "positionName",
  cs.status AS "consentStatus",
  EXISTS (SELECT 1 FROM device dv WHERE dv.tenant_id = e.tenant_id AND dv.employee_id = e.id AND dv.status = 'ACTIVE') AS "hasActiveDevice",
  e.created_at AS "createdAt"`;

const FROM = `
  FROM employee e
  JOIN department d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
  JOIN location l ON l.tenant_id = e.tenant_id AND l.id = e.primary_location_id
  LEFT JOIN employee_consent_status cs ON cs.tenant_id = e.tenant_id AND cs.employee_id = e.id
  LEFT JOIN employee_rank_assignment ra ON ra.tenant_id = e.tenant_id AND ra.employee_id = e.id AND ra.valid_to IS NULL
  LEFT JOIN job_rank jr ON jr.tenant_id = ra.tenant_id AND jr.id = ra.job_rank_id
  LEFT JOIN employee_position_assignment pa ON pa.tenant_id = e.tenant_id AND pa.employee_id = e.id AND pa.valid_to IS NULL
  LEFT JOIN job_position jp ON jp.tenant_id = pa.tenant_id AND jp.id = pa.job_position_id`;

const SORT_COLUMNS = {
  employeeNo: "e.employee_no",
  fullName: "e.full_name",
  createdAt: "e.created_at",
} as const;

const COLUMN_FOR: Record<string, string> = {
  employeeNo: "employee_no",
  fullName: "full_name",
  departmentId: "department_id",
  primaryLocationId: "primary_location_id",
  startDate: "start_date",
  endDate: "end_date",
  scheduleMode: "schedule_mode",
  manualAttendance: "manual_attendance",
};

const pgCode = (error: unknown) => (error as { code?: string })?.code;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly jobs: JobHistoryService,
  ) {}

  // ------------------------------------------------------------------ reading

  /** Disabled and archived employees are hidden unless asked for (PRD 12.2). Limited to the caller's scope (PRD 4). */
  async list(auth: AuthContext, filter: EmployeeFilter) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const where: string[] = [this.scopes.employeeCondition(scope, "e", params)];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (filter.status !== "ALL") add("e.status = ?", filter.status);
      if (filter.departmentId) add("e.department_id = ?", filter.departmentId);
      if (filter.locationId) add("e.primary_location_id = ?", filter.locationId);
      if (filter.scheduleMode) add("e.schedule_mode = ?", filter.scheduleMode);
      if (filter.manualAttendance !== undefined)
        add("e.manual_attendance = ?", filter.manualAttendance);
      if (filter.rankId) add("ra.job_rank_id = ?", filter.rankId);
      if (filter.positionId) add("pa.job_position_id = ?", filter.positionId);
      if (filter.consentStatus)
        add("COALESCE(cs.status, 'NOT_REQUESTED') = ?", filter.consentStatus);
      if (filter.hasDevice !== undefined) {
        where.push(
          `${filter.hasDevice ? "" : "NOT "}EXISTS (SELECT 1 FROM device dv WHERE dv.tenant_id = e.tenant_id AND dv.employee_id = e.id AND dv.status = 'ACTIVE')`,
        );
      }
      if (filter.q) {
        params.push(`%${likeEscape(filter.q)}%`);
        where.push(
          `(e.full_name ILIKE $${params.length} OR e.employee_no ILIKE $${params.length})`,
        );
      }
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n ${FROM} WHERE ${where.join(" AND ")}`,
        params,
      );
      params.push(filter.limit, filter.offset);
      const { rows } = await tx.query(
        `SELECT ${SELECT} ${FROM} WHERE ${where.join(" AND ")}
          ORDER BY ${SORT_COLUMNS[filter.sort]} ${filter.order === "desc" ? "DESC" : "ASC"}, e.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: total.rows[0]!.n, limit: filter.limit, offset: filter.offset, items: rows };
    });
  }

  async get(auth: AuthContext, id: string) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const row = await this.loadVisible(tx, scope, id);
      const account = await tx.query(
        'SELECT id AS "userId", username, status FROM user_account WHERE employee_id = $1',
        [id],
      );
      const device = await tx.query(
        `SELECT id, platform, model, os_version AS "osVersion", registered_at AS "registeredAt"
           FROM device WHERE employee_id = $1 AND status = 'ACTIVE'`,
        [id],
      );
      return { ...row, account: account.rows[0] ?? null, device: device.rows[0] ?? null };
    });
  }

  // ------------------------------------------------------------------ create / update

  async create(auth: AuthContext, input: EmployeeFields, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      this.assertInScope(scope, input.departmentId, input.primaryLocationId);
      await this.assertActiveReferences(tx, input.departmentId, input.primaryLocationId);
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO employee
             (tenant_id, employee_no, full_name, department_id, primary_location_id, start_date, end_date, schedule_mode, manual_attendance)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            auth.tenantId,
            input.employeeNo,
            input.fullName,
            input.departmentId,
            input.primaryLocationId,
            input.startDate ?? null,
            input.endDate ?? null,
            input.scheduleMode ?? "STANDARD",
            input.manualAttendance ?? false,
          ],
        );
        id = rows[0]!.id;
      } catch (error) {
        throw this.mapWriteError(error);
      }
      const today = await this.tenantToday(tx, auth.tenantId);
      const from = input.startDate && input.startDate <= today ? input.startDate : today;
      const initial = { id, startDate: null };
      if (input.rankId) {
        await this.jobs.assign(
          tx,
          auth,
          "rank",
          initial,
          { catalogId: input.rankId, effectiveDate: from },
          today,
          meta,
        );
      }
      if (input.positionId) {
        await this.jobs.assign(
          tx,
          auth,
          "position",
          initial,
          { catalogId: input.positionId, effectiveDate: from },
          today,
          meta,
        );
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "employee.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "employee",
        entityId: id,
        after: input,
        ...meta,
      });
      return this.loadVisible(tx, scope, id);
    });
  }

  /**
   * Edits are allowed for active and disabled employees; archived ones are read-only (PRD 12.2).
   * NOTE: department / primary location changes take effect from now on and are recorded in the audit log;
   * effective-dated history (PRD 22.1) is a separate, later piece of work.
   */
  async update(auth: AuthContext, id: string, input: Partial<EmployeeFields>, meta: RequestMeta) {
    const { rankId, positionId, ...fields } = input;
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const current = await this.loadVisible(tx, scope, id);
      if (current.status === "ARCHIVED") {
        throw new ApiError(
          409,
          "EMPLOYEE_ARCHIVED",
          "Archived employees are read-only. Reactivate the employee first.",
        );
      }
      const departmentId = input.departmentId ?? current.departmentId;
      const locationId = input.primaryLocationId ?? current.primaryLocationId;
      this.assertInScope(scope, departmentId, locationId);
      if (input.departmentId || input.primaryLocationId) {
        await this.assertActiveReferences(
          tx,
          input.departmentId ? departmentId : null,
          input.primaryLocationId ? locationId : null,
        );
      }
      const columns: Record<string, unknown> = {};
      for (const [key, column] of Object.entries(COLUMN_FOR)) {
        const value = (fields as Record<string, unknown>)[key];
        if (value !== undefined) columns[column] = value;
      }
      let result;
      try {
        result = await updateColumns(tx, "employee", id, columns);
      } catch (error) {
        throw this.mapWriteError(error);
      }
      if (result.changed) {
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "employee.updated",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "employee",
          entityId: id,
          before: result.before,
          after: fields,
          ...meta,
        });
      }
      // A different rank / position takes effect today; choosing the current one is a no-op here.
      const today = await this.tenantToday(tx, auth.tenantId);
      const employee = { id, startDate: current.startDate };
      if (rankId && rankId !== current.rankId) {
        await this.jobs.assign(tx, auth, "rank", employee, { catalogId: rankId }, today, meta);
      }
      if (positionId && positionId !== current.positionId) {
        await this.jobs.assign(
          tx,
          auth,
          "position",
          employee,
          { catalogId: positionId },
          today,
          meta,
        );
      }
      return this.loadVisible(tx, scope, id);
    });
  }

  // ------------------------------------------------------------------ rank / position history (PRD 12, 22.1)

  async jobHistory(auth: AuthContext, kind: JobKind, id: string) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      await this.loadVisible(tx, scope, id);
      return this.jobs.history(tx, kind, id);
    });
  }

  /** Promotion / transfer from `effectiveDate` (default today). Archived employees are read-only. */
  async assignJob(
    auth: AuthContext,
    kind: JobKind,
    id: string,
    input: AssignInput,
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const employee = await this.loadVisible(tx, scope, id);
      if (employee.status === "ARCHIVED") {
        throw new ApiError(
          409,
          "EMPLOYEE_ARCHIVED",
          "Archived employees are read-only. Reactivate the employee first.",
        );
      }
      const today = await this.tenantToday(tx, auth.tenantId);
      await this.jobs.assign(
        tx,
        auth,
        kind,
        { id, startDate: employee.startDate },
        input,
        today,
        meta,
      );
      return this.jobs.history(tx, kind, id);
    });
  }

  // ------------------------------------------------------------------ lifecycle (PRD 12.2)

  /**
   * Resignation / termination. Login is blocked and sessions end, the device is deactivated (database trigger),
   * future temporary assignments are removed and running ones end, open replacement QR codes are cancelled.
   * History stays. Scheduling a disable for a future date is not supported yet.
   */
  async disable(
    auth: AuthContext,
    id: string,
    input: { effectiveDate?: string; reason?: string },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const employee = await this.loadVisible(tx, scope, id);
      if (employee.status !== "ACTIVE") {
        throw new ApiError(
          409,
          "EMPLOYEE_NOT_ACTIVE",
          `The employee is already ${employee.status}.`,
        );
      }
      const today = await this.tenantToday(tx, auth.tenantId);
      const effective = input.effectiveDate ?? today;
      if (effective > today) {
        throw new ApiError(
          400,
          "EFFECTIVE_DATE_IN_FUTURE",
          "Disabling on a future date is not supported yet; use today or a past date.",
        );
      }
      if (employee.startDate && effective < employee.startDate) {
        throw new ApiError(
          400,
          "EFFECTIVE_DATE_BEFORE_START",
          "The effective date is before the employee's start date.",
        );
      }

      const device = await tx.query(
        "SELECT 1 FROM device WHERE employee_id = $1 AND status = 'ACTIVE'",
        [id],
      );
      await tx.query("UPDATE employee SET status = 'DISABLED', end_date = $2 WHERE id = $1", [
        id,
        effective,
      ]);

      const accounts = await tx.query<{ id: string }>(
        "UPDATE user_account SET status = 'DISABLED' WHERE employee_id = $1 AND status = 'ACTIVE' RETURNING id",
        [id],
      );
      for (const account of accounts.rows) await this.sessions.revokeAllForUser(tx, account.id);

      const ended = await tx.query(
        "UPDATE temp_location_assignment SET to_date = $2 WHERE employee_id = $1 AND from_date <= $2 AND to_date > $2",
        [id, effective],
      );
      const removed = await tx.query(
        "DELETE FROM temp_location_assignment WHERE employee_id = $1 AND from_date > $2",
        [id, effective],
      );
      // PRD 12.2: reasons open after the effective date end with the employment; later ones are removed.
      const reasonsEnded = await tx.query(
        "UPDATE reason_assignment SET to_date = $2, ended_at = $3, ended_by = $4 WHERE employee_id = $1 AND from_date <= $2 AND (to_date IS NULL OR to_date > $2)",
        [id, effective, this.clock.now(), auth.userId],
      );
      const reasonsRemoved = await tx.query(
        "DELETE FROM reason_assignment WHERE employee_id = $1 AND from_date > $2",
        [id, effective],
      );
      await tx.query(
        "UPDATE onboarding_qr SET cancelled_at = $2 WHERE employee_id = $1 AND cancelled_at IS NULL",
        [id, this.clock.now()],
      );

      const summary = {
        status: "DISABLED" as const,
        endDate: effective,
        deviceDisabled: (device.rowCount ?? 0) > 0,
        accountDisabled: accounts.rowCount === 1,
        temporaryAssignmentsEnded: ended.rowCount ?? 0,
        temporaryAssignmentsRemoved: removed.rowCount ?? 0,
        reasonAssignmentsEnded: reasonsEnded.rowCount ?? 0,
        reasonAssignmentsRemoved: reasonsRemoved.rowCount ?? 0,
      };
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "employee.disabled",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "employee",
        entityId: id,
        after: { ...summary, reason: input.reason ?? null },
        ...meta,
      });
      return summary;
    });
  }

  /**
   * Re-hire / return: the same record and history are reused. Department and primary location must be
   * re-confirmed; the login account (if any) gets a new one-time password; the old device stays disabled, so
   * a new device must be registered with a new QR (PRD 12.2).
   */
  async reactivate(
    auth: AuthContext,
    id: string,
    input: { departmentId: string; primaryLocationId: string; startDate?: string },
    meta: RequestMeta,
  ) {
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const employee = await this.loadVisible(tx, scope, id);
      if (employee.status === "ACTIVE")
        throw new ApiError(409, "EMPLOYEE_ALREADY_ACTIVE", "The employee is already active.");
      this.assertInScope(scope, input.departmentId, input.primaryLocationId);
      await this.assertActiveReferences(tx, input.departmentId, input.primaryLocationId);

      const startDate = input.startDate ?? (await this.tenantToday(tx, auth.tenantId));
      await tx.query(
        `UPDATE employee
            SET status = 'ACTIVE', start_date = $2, end_date = NULL, department_id = $3, primary_location_id = $4
          WHERE id = $1`,
        [id, startDate, input.departmentId, input.primaryLocationId],
      );
      const account = await tx.query<{ id: string }>(
        `UPDATE user_account
            SET status = 'ACTIVE', password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL
          WHERE employee_id = $1 RETURNING id`,
        [id, passwordHash],
      );
      for (const row of account.rows) await this.sessions.revokeAllForUser(tx, row.id);

      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "employee.reactivated",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "employee",
        entityId: id,
        before: {
          status: employee.status,
          departmentId: employee.departmentId,
          primaryLocationId: employee.primaryLocationId,
        },
        after: {
          startDate,
          departmentId: input.departmentId,
          primaryLocationId: input.primaryLocationId,
        },
        ...meta,
      });
      return {
        status: "ACTIVE" as const,
        startDate,
        deviceRegistrationRequired: true,
        ...(account.rowCount === 1 ? { temporaryPassword } : {}),
      };
    });
  }

  /** A disabled employee can be archived after the retention period (tenant setting, default 12 months). */
  async archive(auth: AuthContext, id: string, input: { force?: boolean }, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const employee = await this.loadVisible(tx, scope, id);
      if (employee.status !== "DISABLED") {
        throw new ApiError(
          409,
          "EMPLOYEE_NOT_DISABLED",
          "Only a disabled employee can be archived.",
        );
      }
      const months = await this.archiveAfterMonths(tx);
      const today = await this.tenantToday(tx, auth.tenantId);
      const earliest = employee.endDate ? subtractMonths(today, months) : today;
      const tooEarly = employee.endDate !== null && employee.endDate > earliest;
      if (tooEarly) {
        if (!(input.force && auth.role === "ORG_ADMIN")) {
          throw new ApiError(
            409,
            "ARCHIVE_TOO_EARLY",
            `An employee can be archived ${months} months after leaving. An Organization Admin may force it.`,
            {
              retentionMonths: months,
              leftOn: employee.endDate,
            },
          );
        }
      }
      await tx.query("UPDATE employee SET status = 'ARCHIVED' WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "employee.archived",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "employee",
        entityId: id,
        after: { forced: tooEarly },
        ...meta,
      });
      return { status: "ARCHIVED" as const };
    });
  }

  // ------------------------------------------------------------------ login account

  /** HR gives the employee a login (PRD 5 step 2). Returns a one-time temporary password; they must change it. */
  async createAccount(
    auth: AuthContext,
    id: string,
    input: { username: string },
    meta: RequestMeta,
  ) {
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const employee = await this.loadVisible(tx, scope, id);
      if (employee.status !== "ACTIVE")
        throw new ApiError(409, "EMPLOYEE_NOT_ACTIVE", "The employee is not active.");
      const existing = await tx.query("SELECT 1 FROM user_account WHERE employee_id = $1", [id]);
      if ((existing.rowCount ?? 0) > 0)
        throw new ApiError(409, "ACCOUNT_EXISTS", "The employee already has a login account.");
      let userId: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO user_account (tenant_id, username, display_name, password_hash, role, employee_id)
           VALUES ($1, $2, $3, $4, 'EMPLOYEE', $5) RETURNING id`,
          [auth.tenantId, input.username, employee.fullName, passwordHash, id],
        );
        userId = rows[0]!.id;
      } catch (error) {
        if (pgCode(error) === "23505")
          throw new ApiError(409, "USERNAME_TAKEN", "That username is already in use.");
        throw error;
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "employee.account_created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "employee",
        entityId: id,
        after: { userId, username: input.username },
        ...meta,
      });
      return { userId, username: input.username, temporaryPassword };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async loadVisible(tx: Db, scope: DataScope, id: string) {
    const params: unknown[] = [id];
    const condition = this.scopes.employeeCondition(scope, "e", params);
    const { rows } = await tx.query(
      `SELECT ${SELECT} ${FROM} WHERE e.id = $1 AND ${condition}`,
      params,
    );
    const row = rows[0] as
      | (Record<string, unknown> & {
          status: string;
          departmentId: string;
          primaryLocationId: string;
          startDate: string | null;
          endDate: string | null;
          fullName: string;
          rankId: string | null;
          positionId: string | null;
        })
      | undefined;
    // An employee outside the caller's scope looks exactly like one that does not exist.
    if (!row) throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
    return row;
  }

  private assertInScope(scope: DataScope, departmentId: string, locationId: string): void {
    if (scope.unrestricted) return;
    if (scope.locationIds.includes(locationId) || scope.departmentIds.includes(departmentId))
      return;
    throw forbidden("This department and location are outside your assigned scope.");
  }

  private async assertActiveReferences(
    tx: Db,
    departmentId: string | null,
    locationId: string | null,
  ): Promise<void> {
    if (departmentId) {
      const d = await tx.query<{ active: boolean }>("SELECT active FROM department WHERE id = $1", [
        departmentId,
      ]);
      if (!d.rows[0])
        throw new ApiError(400, "DEPARTMENT_NOT_FOUND", "The department does not exist.");
      if (!d.rows[0].active)
        throw new ApiError(400, "DEPARTMENT_INACTIVE", "The department is inactive.");
    }
    if (locationId) {
      const l = await tx.query<{ active: boolean }>("SELECT active FROM location WHERE id = $1", [
        locationId,
      ]);
      if (!l.rows[0]) throw new ApiError(400, "LOCATION_NOT_FOUND", "The location does not exist.");
      if (!l.rows[0].active)
        throw new ApiError(400, "LOCATION_INACTIVE", "The location is inactive.");
    }
  }

  private mapWriteError(error: unknown): unknown {
    if (pgCode(error) === "23505")
      return new ApiError(409, "EMPLOYEE_NO_TAKEN", "That employee number is already in use.");
    if (pgCode(error) === "23514")
      return new ApiError(400, "INVALID_DATES", "The end date cannot be before the start date.");
    return error;
  }

  private async tenantToday(tx: Db, tenantId: string): Promise<string> {
    const { rows } = await tx.query<{ time_zone: string }>(
      "SELECT time_zone FROM tenant WHERE id = $1",
      [tenantId],
    );
    return todayIn(rows[0]?.time_zone ?? "Asia/Ulaanbaatar", this.clock.now());
  }

  private async archiveAfterMonths(tx: Db): Promise<number> {
    const { rows } = await tx.query<{ value: unknown }>(
      "SELECT value FROM tenant_setting WHERE key = 'archive_after_months'",
    );
    const value = rows[0]?.value;
    return typeof value === "number" && value >= 0 ? value : 12;
  }
}
