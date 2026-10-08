import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { updateColumns } from "../common/sql";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { ScopeService } from "../access/scope.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";

const pgCode = (error: unknown) => (error as { code?: string })?.code;

export interface AssignInput {
  employeeIds: string[];
  reasonId: string;
  fromDate: string;
  toDate?: string | null;
  description?: string | null;
}

export interface AssignmentFilter {
  employeeId?: string;
  reasonId?: string;
  departmentId?: string;
  locationId?: string;
  from?: string;
  to?: string;
  activeOn?: string;
  limit: number;
  offset: number;
}

/**
 * Absence reasons and dated reason assignments (PRD 11, 6.6). A reason covers a calendar date range for one
 * employee, one at a time; HR can end it early or delete one that has not started. Which status a date gets
 * is decided by the attendance rules, not here.
 */
@Injectable()
export class ReasonsService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
  ) {}

  // ------------------------------------------------------------------ the list of reasons (Org Admin)

  async list(auth: AuthContext, filter: { active?: boolean }) {
    return this.db.withTenant(auth.tenantId, (tx) =>
      this.select(tx, auth, { active: filter.active }),
    );
  }

  async get(auth: AuthContext, id: string) {
    const found = await this.db.withTenant(
      auth.tenantId,
      async (tx) => (await this.select(tx, auth, { id }))[0],
    );
    if (!found) throw new ApiError(404, "REASON_NOT_FOUND", "Reason not found.");
    return found;
  }

  private async select(tx: Db, auth: AuthContext, f: { id?: string; active?: boolean }) {
    const withCounts = auth.role !== "MANAGER";
    const { rows } = await tx.query(
      `SELECT r.id, r.name, r.sort_order AS "sortOrder", r.active,
              ${
                withCounts
                  ? `(SELECT count(*)::int FROM reason_assignment a WHERE a.tenant_id = r.tenant_id AND a.reason_id = r.id)`
                  : "NULL::int"
              } AS "assignments"
         FROM absence_reason r
        WHERE ($1::uuid IS NULL OR r.id = $1) AND ($2::boolean IS NULL OR r.active = $2)
        ORDER BY r.sort_order, r.name`,
      [f.id ?? null, f.active ?? null],
    );
    return rows;
  }

  async create(auth: AuthContext, input: { name: string; sortOrder?: number }, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      let id: string;
      try {
        const order =
          input.sortOrder ??
          (
            await tx.query<{ n: number }>(
              "SELECT COALESCE(max(sort_order), 0)::int + 1 AS n FROM absence_reason",
            )
          ).rows[0]!.n;
        const { rows } = await tx.query<{ id: string }>(
          "INSERT INTO absence_reason (tenant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id",
          [auth.tenantId, input.name, order],
        );
        id = rows[0]!.id;
      } catch (error) {
        throw this.mapName(error);
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "reason.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "absence_reason",
        entityId: id,
        after: input,
        ...meta,
      });
      return (await this.select(tx, auth, { id }))[0];
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    input: { name?: string; sortOrder?: number; active?: boolean },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      if ((await this.select(tx, auth, { id })).length === 0) {
        throw new ApiError(404, "REASON_NOT_FOUND", "Reason not found.");
      }
      let result;
      try {
        result = await updateColumns(tx, "absence_reason", id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        });
      } catch (error) {
        throw this.mapName(error);
      }
      if (result.changed) {
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "reason.updated",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "absence_reason",
          entityId: id,
          before: result.before,
          after: input,
          ...meta,
        });
      }
      return (await this.select(tx, auth, { id }))[0];
    });
  }

  /** Only a reason nobody ever got can be deleted; otherwise deactivate it (history is kept). */
  async removeReason(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ name: string }>(
        "SELECT name FROM absence_reason WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!found.rows[0]) throw new ApiError(404, "REASON_NOT_FOUND", "Reason not found.");
      const used = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM reason_assignment WHERE reason_id = $1",
        [id],
      );
      if (used.rows[0]!.n > 0) {
        throw new ApiError(
          409,
          "REASON_IN_USE",
          "The reason has been assigned; deactivate it instead.",
          {
            assignments: used.rows[0]!.n,
          },
        );
      }
      await tx.query("DELETE FROM absence_reason WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "reason.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "absence_reason",
        entityId: id,
        before: { name: found.rows[0].name },
        ...meta,
      });
    });
  }

  private mapName(error: unknown): unknown {
    if (pgCode(error) !== "23505") return error;
    const constraint = (error as { constraint?: string }).constraint ?? "";
    return constraint.includes("name")
      ? new ApiError(409, "REASON_NAME_TAKEN", "A reason with this name already exists.")
      : error;
  }

  // ------------------------------------------------------------------ assignments (HR)

  async listAssignments(auth: AuthContext, f: AssignmentFilter) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const where: string[] = [this.scopes.employeeCondition(scope, "e", params)];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.employeeId) add("a.employee_id = ?", f.employeeId);
      if (f.reasonId) add("a.reason_id = ?", f.reasonId);
      if (f.departmentId) add("e.department_id = ?", f.departmentId);
      if (f.locationId) add("e.primary_location_id = ?", f.locationId);
      if (f.from) add("(a.to_date IS NULL OR a.to_date >= ?::date)", f.from);
      if (f.to) add("a.from_date <= ?::date", f.to);
      if (f.activeOn) {
        add("a.from_date <= ?::date", f.activeOn);
        add("(a.to_date IS NULL OR a.to_date >= ?::date)", f.activeOn);
      }
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM reason_assignment a
           JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id WHERE ${where.join(" AND ")}`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows } = await tx.query(
        `${this.assignmentSelect()} WHERE ${where.join(" AND ")}
          ORDER BY a.from_date DESC, e.employee_no
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: total.rows[0]!.n, limit: f.limit, offset: f.offset, items: rows };
    });
  }

  private assignmentSelect(): string {
    return `SELECT a.id, a.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
                   a.reason_id AS "reasonId", r.name AS "reasonName",
                   a.from_date::text AS "fromDate", a.to_date::text AS "toDate", a.description,
                   a.created_at AS "createdAt", a.ended_at AS "endedAt"
              FROM reason_assignment a
              JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
              JOIN absence_reason r ON r.tenant_id = a.tenant_id AND r.id = a.reason_id`;
  }

  /**
   * Gives one or more employees (all or nothing) a reason for a date range. Past dates are allowed: HR assigns a
   * reason to a day that was already Ирээгүй (PRD 6.3). An employee has one reason at a time; overlaps are
   * reported with the clashing assignments.
   */
  async assign(auth: AuthContext, input: AssignInput, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const reason = await tx.query<{ name: string; active: boolean }>(
        "SELECT name, active FROM absence_reason WHERE id = $1",
        [input.reasonId],
      );
      if (!reason.rows[0])
        throw new ApiError(400, "REASON_NOT_FOUND", "The reason does not exist.");
      if (!reason.rows[0].active)
        throw new ApiError(400, "REASON_INACTIVE", "The reason is inactive.");

      const params: unknown[] = [input.employeeIds];
      const condition = this.scopes.employeeCondition(scope, "e", params);
      const found = await tx.query<{ id: string; status: string }>(
        `SELECT e.id, e.status FROM employee e WHERE e.id = ANY($1::uuid[]) AND ${condition}`,
        params,
      );
      if (found.rows.length !== input.employeeIds.length) {
        throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "One or more employees were not found.");
      }
      const inactive = found.rows.filter((r) => r.status !== "ACTIVE").map((r) => r.id);
      if (inactive.length > 0) {
        throw new ApiError(409, "EMPLOYEE_NOT_ACTIVE", "Only active employees can get a reason.", {
          employeeIds: inactive,
        });
      }

      const conflicts = await tx.query(
        `SELECT a.id AS "assignmentId", a.employee_id AS "employeeId", r.name AS "reasonName",
                a.from_date::text AS "fromDate", a.to_date::text AS "toDate"
           FROM reason_assignment a JOIN absence_reason r ON r.tenant_id = a.tenant_id AND r.id = a.reason_id
          WHERE a.employee_id = ANY($1::uuid[])
            AND daterange(a.from_date, a.to_date, '[]') && daterange($2::date, $3::date, '[]')
          ORDER BY a.employee_id, a.from_date`,
        [input.employeeIds, input.fromDate, input.toDate ?? null],
      );
      if ((conflicts.rowCount ?? 0) > 0) {
        throw new ApiError(
          409,
          "REASON_OVERLAP",
          "An employee already has a reason in this period; end or shorten it first.",
          { conflicts: conflicts.rows },
        );
      }

      const ids: string[] = [];
      try {
        for (const employeeId of input.employeeIds) {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO reason_assignment (tenant_id, employee_id, reason_id, from_date, to_date, description, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              auth.tenantId,
              employeeId,
              input.reasonId,
              input.fromDate,
              input.toDate ?? null,
              input.description ?? null,
              auth.userId,
            ],
          );
          ids.push(rows[0]!.id);
        }
      } catch (error) {
        if (pgCode(error) === "23P01") {
          throw new ApiError(
            409,
            "REASON_OVERLAP",
            "An employee already has a reason in this period.",
          );
        }
        throw error;
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "reason_assignment.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "reason_assignment",
        entityId: ids[0],
        after: { ...input, reasonName: reason.rows[0].name, assignmentIds: ids },
        ...meta,
      });
      return { created: ids.length, assignmentIds: ids };
    });
  }

  /** Ends a reason on `endDate` (inclusive) — earlier than planned, or an open one. History stays. */
  async end(auth: AuthContext, id: string, endDate: string, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const current = await this.visible(tx, auth, id);
      if (endDate < current.fromDate) {
        throw new ApiError(
          400,
          "INVALID_DATES",
          "The end date is before the reason starts; delete it instead.",
        );
      }
      if (current.toDate !== null && endDate >= current.toDate) {
        throw new ApiError(
          400,
          "INVALID_DATES",
          "A reason can only be ended earlier than planned.",
        );
      }
      await tx.query(
        "UPDATE reason_assignment SET to_date = $2, ended_at = $3, ended_by = $4 WHERE id = $1",
        [id, endDate, this.clock.now(), auth.userId],
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "reason_assignment.ended",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "reason_assignment",
        entityId: id,
        before: { toDate: current.toDate },
        after: { toDate: endDate },
        ...meta,
      });
      return (await tx.query(`${this.assignmentSelect()} WHERE a.id = $1`, [id])).rows[0];
    });
  }

  /** A reason that has not started yet can be deleted (audited); started ones are ended instead. */
  async removeAssignment(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const current = await this.visible(tx, auth, id);
      const today = await tenantToday(tx, this.clock, auth.tenantId);
      if (current.fromDate <= today) {
        throw new ApiError(
          409,
          "REASON_STARTED",
          "The reason has started; end it instead of deleting it.",
        );
      }
      await tx.query("DELETE FROM reason_assignment WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "reason_assignment.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "reason_assignment",
        entityId: id,
        before: current,
        ...meta,
      });
    });
  }

  private async visible(tx: Db, auth: AuthContext, id: string) {
    const scope = await this.scopes.forUser(tx, auth);
    const params: unknown[] = [id];
    const condition = this.scopes.employeeCondition(scope, "e", params);
    const { rows } = await tx.query<{
      employeeId: string;
      reasonId: string;
      fromDate: string;
      toDate: string | null;
    }>(
      `SELECT a.employee_id AS "employeeId", a.reason_id AS "reasonId", a.from_date::text AS "fromDate", a.to_date::text AS "toDate"
         FROM reason_assignment a JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
        WHERE a.id = $1 AND ${condition} FOR UPDATE OF a`,
      params,
    );
    if (!rows[0])
      throw new ApiError(404, "REASON_ASSIGNMENT_NOT_FOUND", "Reason assignment not found.");
    return rows[0];
  }

  // ------------------------------------------------------------------ reason report (PRD 11.1)

  /** Per reason: distinct employees and total employee-days inside the period (clipped to it). */
  async report(
    auth: AuthContext,
    f: { from: string; to: string; locationId?: string; departmentId?: string },
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [f.from, f.to];
      const where: string[] = [this.scopes.employeeCondition(scope, "e", params)];
      if (f.locationId) {
        params.push(f.locationId);
        where.push(`e.primary_location_id = $${params.length}`);
      }
      if (f.departmentId) {
        params.push(f.departmentId);
        where.push(`e.department_id = $${params.length}`);
      }
      const { rows } = await tx.query(
        `SELECT r.id AS "reasonId", r.name AS "reasonName", COALESCE(x.employees, 0) AS employees,
                COALESCE(x.days, 0) AS "employeeDays"
           FROM absence_reason r
           LEFT JOIN (
             SELECT a.reason_id, count(DISTINCT a.employee_id)::int AS employees,
                    sum(LEAST(COALESCE(a.to_date, $2::date), $2::date) - GREATEST(a.from_date, $1::date) + 1)::int AS days
               FROM reason_assignment a JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
              WHERE ${where.join(" AND ")} AND a.from_date <= $2::date AND COALESCE(a.to_date, $2::date) >= $1::date
              GROUP BY a.reason_id
           ) x ON x.reason_id = r.id
          WHERE r.active OR x.employees IS NOT NULL
          ORDER BY r.sort_order, r.name`,
        params,
      );
      return { from: f.from, to: f.to, items: rows };
    });
  }
}
