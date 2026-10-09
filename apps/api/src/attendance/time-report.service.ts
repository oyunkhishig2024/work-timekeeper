import { Injectable } from "@nestjs/common";
import { daysBetween } from "@timekeeper/domain";
import { ScopeService } from "../access/scope.service";
import type { AuthContext } from "../auth/auth.types";
import { ApiError } from "../common/api-error";
import { DatabaseService } from "../database/database.service";

export type TimeReportKind = "short" | "overtime";

export interface TimeReportFilter {
  kind: TimeReportKind;
  from: string;
  to: string;
  locationId?: string;
  departmentId?: string;
  q?: string;
  limit: number;
  offset: number;
}

/** The longest period one report covers (about three months). */
export const MAX_REPORT_DAYS = 93;

/**
 * Short-hours (дутуу цаг) and overtime (илүү цаг) reports for a week, a month or any period (PRD 9, 23.2). The numbers are the
 * derived ones in `attendance_result` (late minutes, early-leave minutes, overtime minutes, no-show days): nothing is worked out
 * here. Short minutes = late minutes + early-leave minutes; a no-show day is counted as a day, not as minutes.
 */
@Injectable()
export class TimeReportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
  ) {}

  async report(auth: AuthContext, f: TimeReportFilter) {
    if (daysBetween(f.from, f.to) + 1 > MAX_REPORT_DAYS) {
      throw new ApiError(400, "RANGE_TOO_LONG", `At most ${MAX_REPORT_DAYS} days.`);
    }
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [f.from, f.to];
      const where: string[] = [
        "r.work_date BETWEEN $1 AND $2",
        this.scopes.employeeCondition(scope, "e", params),
      ];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.locationId) add("e.primary_location_id = ?", f.locationId);
      if (f.departmentId) add("e.department_id = ?", f.departmentId);
      if (f.q) {
        params.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
        where.push(
          `(e.full_name ILIKE $${params.length} OR e.employee_no ILIKE $${params.length})`,
        );
      }
      const having =
        f.kind === "overtime"
          ? "COALESCE(sum(r.overtime_minutes), 0) > 0"
          : "(COALESCE(sum(r.late_minutes) FILTER (WHERE r.status = 'LATE'), 0) + COALESCE(sum(r.early_leave_minutes), 0) > 0 OR count(*) FILTER (WHERE r.status = 'NO_SHOW') > 0)";
      const body = `
        FROM attendance_result r
        JOIN employee e ON e.id = r.employee_id
        LEFT JOIN department d ON d.id = e.department_id
        LEFT JOIN location pl ON pl.id = e.primary_location_id
       WHERE ${where.join(" AND ")}
       GROUP BY e.id, d.name, pl.name
      HAVING ${having}`;
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT e.id ${body}) x`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT e.id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName",
                (SELECT a.title FROM employee_rank_assignment a WHERE a.employee_id = e.id
                    AND a.valid_from <= $2::date AND (a.valid_to IS NULL OR a.valid_to > $2::date) LIMIT 1) AS rank,
                (SELECT a.title FROM employee_position_assignment a WHERE a.employee_id = e.id
                    AND a.valid_from <= $2::date AND (a.valid_to IS NULL OR a.valid_to > $2::date) LIMIT 1) AS position,
                d.name AS "departmentName", pl.name AS "primaryLocationName",
                count(*) FILTER (WHERE r.status IN ('ON_TIME', 'LATE', 'EXCUSED', 'NO_SHOW', 'PENDING'))::int AS "expectedDays",
                count(*) FILTER (WHERE r.status IN ('ON_TIME', 'LATE'))::int AS "attendedDays",
                count(*) FILTER (WHERE r.status = 'LATE')::int AS "lateDays",
                COALESCE(sum(r.late_minutes) FILTER (WHERE r.status = 'LATE'), 0)::int AS "lateMinutes",
                count(*) FILTER (WHERE r.early_leave_minutes > 0)::int AS "earlyLeaveDays",
                COALESCE(sum(r.early_leave_minutes), 0)::int AS "earlyLeaveMinutes",
                count(*) FILTER (WHERE r.status = 'NO_SHOW')::int AS "noShowDays",
                count(*) FILTER (WHERE r.overtime_minutes > 0)::int AS "overtimeDays",
                COALESCE(sum(r.overtime_minutes), 0)::int AS "overtimeMinutes"
          ${body}
          ORDER BY e.employee_no
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const items = rows.map((r) => ({
        ...r,
        shortMinutes: Number(r.lateMinutes) + Number(r.earlyLeaveMinutes),
      }));
      return {
        kind: f.kind,
        from: f.from,
        to: f.to,
        total: total.rows[0]!.n,
        limit: f.limit,
        offset: f.offset,
        items,
      };
    });
  }

  /**
   * Days people came on a holiday or a day off (PRD 6.1, v1.30): who, when they came and when they left. Nothing is counted as
   * overtime or short hours; HR decides what such a day means (time off, pay, nothing). One row per employee and date.
   */
  async offDayWork(auth: AuthContext, f: Omit<TimeReportFilter, "kind">) {
    if (daysBetween(f.from, f.to) + 1 > MAX_REPORT_DAYS) {
      throw new ApiError(400, "RANGE_TOO_LONG", `At most ${MAX_REPORT_DAYS} days.`);
    }
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [f.from, f.to];
      const where: string[] = [
        "r.work_date BETWEEN $1 AND $2",
        "r.status = 'WORKED_OFF_DAY'",
        this.scopes.employeeCondition(scope, "e", params),
      ];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.locationId) add("e.primary_location_id = ?", f.locationId);
      if (f.departmentId) add("e.department_id = ?", f.departmentId);
      if (f.q) {
        params.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
        where.push(
          `(e.full_name ILIKE $${params.length} OR e.employee_no ILIKE $${params.length})`,
        );
      }
      const body = `
        FROM attendance_result r
        JOIN employee e ON e.id = r.employee_id
        LEFT JOIN department d ON d.id = e.department_id
        LEFT JOIN location pl ON pl.id = e.primary_location_id
       WHERE ${where.join(" AND ")}`;
      const total = await tx.query<{ n: number }>(`SELECT count(*)::int AS n ${body}`, params);
      params.push(f.limit, f.offset);
      const { rows } = await tx.query(
        `SELECT e.id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName",
                d.name AS "departmentName", pl.name AS "primaryLocationName",
                r.work_date::text AS date, r.arrival_at AS "arrivalAt",
                r.departure_at AS "departureAt", r.departure_state AS "departureState"
          ${body}
          ORDER BY r.work_date, e.employee_no
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        from: f.from,
        to: f.to,
        total: total.rows[0]!.n,
        limit: f.limit,
        offset: f.offset,
        items: rows,
      };
    });
  }
}
