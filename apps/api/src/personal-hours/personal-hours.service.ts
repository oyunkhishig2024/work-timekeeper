import { Injectable } from "@nestjs/common";
import { addDays } from "@timekeeper/domain";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { AttendanceService } from "../attendance/attendance.service";
import { ScopeService } from "../access/scope.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";

const pgCode = (error: unknown) => (error as { code?: string })?.code;

/** How far back and ahead personal hours may be set (days from today). */
const PAST_DAYS = 31;
const FUTURE_DAYS = 90;

export interface PersonalHoursInput {
  employeeIds: string[];
  fromDate: string;
  toDate: string;
  startTime: string;
  endTime: string;
  /** Main place first. Empty: the employee's usual expected place. */
  locationIds: string[];
  note?: string | null;
}

export interface PersonalHoursFilter {
  employeeId?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/**
 * Personal hours (PRD 14.3): HR fixes one employee's hours, and optionally several places, for a range of dates ("come at
 * 06:30 tomorrow and the day after", "worked at two branches today"). `getExpectation` in packages/domain applies them; this
 * service only stores them, checks scope and overlaps, and rebuilds the days that already exist.
 */
@Injectable()
export class PersonalHoursService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
    private readonly attendance: AttendanceService,
  ) {}

  /** Rebuilds the results from `from` to today at once (the worker only looks at yesterday and today). */
  private async refreshDays(
    tx: Db,
    tenantId: string,
    employeeIds: string[],
    from: string,
    to: string,
  ) {
    const today = await tenantToday(tx, this.clock, tenantId);
    const end = to < today ? to : today;
    if (from <= end) {
      await this.attendance.recompute(tx, tenantId, employeeIds, from, end, this.clock.now());
    }
  }

  /** Gives each employee the same hours for the date range, all or nothing. */
  async create(auth: AuthContext, input: PersonalHoursInput, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const today = await tenantToday(tx, this.clock, auth.tenantId);
      if (
        input.fromDate < addDays(today, -PAST_DAYS) ||
        input.toDate > addDays(today, FUTURE_DAYS)
      ) {
        throw new ApiError(
          400,
          "INVALID_DATES",
          `Personal hours can start at most ${PAST_DAYS} days back and end at most ${FUTURE_DAYS} days ahead.`,
        );
      }

      const scope = await this.scopes.forUser(tx, auth);
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
        throw new ApiError(
          409,
          "EMPLOYEE_NOT_ACTIVE",
          "Only active employees can get personal hours.",
          {
            employeeIds: inactive,
          },
        );
      }

      if (input.locationIds.length > 0) {
        const places = await tx.query<{ id: string }>(
          "SELECT id FROM location WHERE id = ANY($1::uuid[]) AND active",
          [input.locationIds],
        );
        if (places.rows.length !== input.locationIds.length) {
          throw new ApiError(
            400,
            "LOCATION_NOT_FOUND",
            "One or more places do not exist or are inactive.",
          );
        }
      }

      const conflicts = await tx.query(
        `SELECT employee_id AS "employeeId", from_date::text AS "fromDate", to_date::text AS "toDate"
           FROM personal_hours
          WHERE employee_id = ANY($1::uuid[]) AND daterange(from_date, to_date, '[]') && daterange($2::date, $3::date, '[]')
          ORDER BY employee_id, from_date`,
        [input.employeeIds, input.fromDate, input.toDate],
      );
      if ((conflicts.rowCount ?? 0) > 0) {
        throw new ApiError(
          409,
          "PERSONAL_HOURS_OVERLAP",
          "An employee already has personal hours in this period; delete them first.",
          { conflicts: conflicts.rows },
        );
      }

      const ids: string[] = [];
      try {
        for (const employeeId of input.employeeIds) {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO personal_hours (tenant_id, employee_id, from_date, to_date, start_time, end_time, note, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              auth.tenantId,
              employeeId,
              input.fromDate,
              input.toDate,
              input.startTime,
              input.endTime,
              input.note ?? null,
              auth.userId,
            ],
          );
          const id = rows[0]!.id;
          ids.push(id);
          for (const [position, locationId] of input.locationIds.entries()) {
            await tx.query(
              `INSERT INTO personal_hours_location (tenant_id, personal_hours_id, location_id, position)
               VALUES ($1, $2, $3, $4)`,
              [auth.tenantId, id, locationId, position],
            );
          }
        }
      } catch (error) {
        if (pgCode(error) === "23P01") {
          throw new ApiError(
            409,
            "PERSONAL_HOURS_OVERLAP",
            "An employee already has personal hours in this period.",
          );
        }
        throw error;
      }
      await this.refreshDays(tx, auth.tenantId, input.employeeIds, input.fromDate, input.toDate);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "personal_hours.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "personal_hours",
        entityId: ids[0],
        after: { ...input, personalHoursIds: ids },
        ...meta,
      });
      return { created: ids.length, personalHoursIds: ids };
    });
  }

  async list(auth: AuthContext, f: PersonalHoursFilter) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const where: string[] = [this.scopes.employeeCondition(scope, "e", params)];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.employeeId) add("p.employee_id = ?", f.employeeId);
      if (f.from) add("p.to_date >= ?::date", f.from);
      if (f.to) add("p.from_date <= ?::date", f.to);
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM personal_hours p
           JOIN employee e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id WHERE ${where.join(" AND ")}`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows } = await tx.query(
        `${this.select()} WHERE ${where.join(" AND ")}
          ORDER BY p.from_date DESC, e.employee_no
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: total.rows[0]!.n, limit: f.limit, offset: f.offset, items: rows };
    });
  }

  private select(): string {
    return `SELECT p.id, p.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
                   p.from_date::text AS "fromDate", p.to_date::text AS "toDate",
                   to_char(p.start_time, 'HH24:MI') AS "startTime", to_char(p.end_time, 'HH24:MI') AS "endTime",
                   p.note, p.created_at AS "createdAt",
                   COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name) ORDER BY pl.position)
                               FROM personal_hours_location pl JOIN location l ON l.tenant_id = pl.tenant_id AND l.id = pl.location_id
                              WHERE pl.personal_hours_id = p.id), '[]'::json) AS locations
              FROM personal_hours p
              JOIN employee e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id`;
  }

  /** Deletes a set of personal hours; the days it covered go back to the usual rules. */
  async remove(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [id];
      const condition = this.scopes.employeeCondition(scope, "e", params);
      const { rows } = await tx.query<{ employeeId: string; fromDate: string; toDate: string }>(
        `SELECT p.employee_id AS "employeeId", p.from_date::text AS "fromDate", p.to_date::text AS "toDate"
           FROM personal_hours p JOIN employee e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id
          WHERE p.id = $1 AND ${condition} FOR UPDATE OF p`,
        params,
      );
      const current = rows[0];
      if (!current)
        throw new ApiError(404, "PERSONAL_HOURS_NOT_FOUND", "Personal hours not found.");
      const before = (await tx.query(`${this.select()} WHERE p.id = $1`, [id])).rows[0];
      await tx.query("DELETE FROM personal_hours WHERE id = $1", [id]);
      await this.refreshDays(
        tx,
        auth.tenantId,
        [current.employeeId],
        current.fromDate,
        current.toDate,
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "personal_hours.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "personal_hours",
        entityId: id,
        before,
        ...meta,
      });
    });
  }
}
