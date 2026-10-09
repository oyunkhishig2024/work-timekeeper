import { Injectable } from "@nestjs/common";
import { isLocationInactive, type AttendanceStatus } from "@timekeeper/domain";
import { ScopeService } from "../access/scope.service";
import type { AuthContext } from "../auth/auth.types";
import { Clock } from "../common/clock";
import { DatabaseService } from "../database/database.service";

export interface DailyFilter {
  date: string;
  /** EXPECTED = everyone expected that day; EARLY_LEAVE = left more than the tolerance before the end of the duty (PRD 23.2); INACTIVE = expected, no arrival, phone silent (PRD 6.5). */
  status?: AttendanceStatus | "EXPECTED" | "INACTIVE" | "EARLY_LEAVE";
  locationId?: string;
  departmentId?: string;
  /** Name or employee code. */
  q?: string;
  limit: number;
  offset: number;
}

const EXPECTED_STATUSES = "('ON_TIME', 'LATE', 'EXCUSED', 'NO_SHOW', 'PENDING')";
/** The INACTIVE filter looks at every candidate of the day before paging, so it is capped. */
const INACTIVE_CAP = 2000;

interface Row {
  status: AttendanceStatus;
  expectedStart: Date | null;
  lastSeenAt: Date | null;
  hasDevice: boolean;
  [key: string]: unknown;
}

/**
 * The daily attendance list (PRD 9): one row per employee expected on the date, with the filters of the screen. Statuses come from
 * `attendance_result`; "Байршил идэвхгүй" is worked out by `isLocationInactive` (packages/domain), never here.
 */
@Injectable()
export class DailyAttendanceService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
  ) {}

  async daily(auth: AuthContext, f: DailyFilter) {
    const now = this.clock.now();
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [f.date];
      const where: string[] = [
        "r.work_date = $1",
        this.scopes.employeeCondition(scope, "e", params),
      ];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.locationId) add("COALESCE(r.location_id, e.primary_location_id) = ?", f.locationId);
      if (f.departmentId) add("e.department_id = ?", f.departmentId);
      if (f.q) {
        params.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
        where.push(
          `(e.full_name ILIKE $${params.length} OR e.employee_no ILIKE $${params.length})`,
        );
      }
      const base = where.join(" AND ");
      const select = `
        SELECT e.id AS "employeeId", e.employee_no AS "employeeNo", e.last_name AS "lastName", e.first_name AS "firstName",
               e.full_name AS "fullName",
               (SELECT a.title FROM employee_rank_assignment a WHERE a.employee_id = e.id
                   AND a.valid_from <= $1::date AND (a.valid_to IS NULL OR a.valid_to > $1::date) LIMIT 1) AS rank,
               (SELECT a.title FROM employee_position_assignment a WHERE a.employee_id = e.id
                   AND a.valid_from <= $1::date AND (a.valid_to IS NULL OR a.valid_to > $1::date) LIMIT 1) AS position,
               d.id AS "departmentId", d.name AS "departmentName",
               l.id AS "locationId", l.name AS "locationName",
               pl.id AS "primaryLocationId", pl.name AS "primaryLocationName",
               (r.location_id IS NOT NULL AND r.location_id <> e.primary_location_id) AS temporary,
               r.status, r.arrival_at AS "arrivalAt", r.late_minutes AS "lateMinutes",
               r.departure_at AS "departureAt", r.departure_state AS "departureState",
               r.early_leave_minutes AS "earlyLeaveMinutes", r.off_day_kind AS "offDayKind",
               r.reason_name AS "reasonName", r.reason_note AS "reasonNote", r.missing,
               r.expected_start AS "expectedStart",
               r.source, r.system_status AS "systemStatus", r.flagged_events AS "flaggedEvents",
               r.correction_id AS "correctionId",
               (SELECT a.id FROM reason_assignment a WHERE a.employee_id = e.id AND a.from_date <= $1::date
                   AND (a.to_date IS NULL OR a.to_date >= $1::date)) AS "reasonAssignmentId",
               dev.last_seen_at AS "lastSeenAt", (dev.id IS NOT NULL) AS "hasDevice"
          FROM attendance_result r
          JOIN employee e ON e.id = r.employee_id
          LEFT JOIN department d ON d.id = e.department_id
          LEFT JOIN location l ON l.id = COALESCE(r.location_id, e.primary_location_id)
          LEFT JOIN location pl ON pl.id = e.primary_location_id
          LEFT JOIN device dev ON dev.employee_id = e.id AND dev.status = 'ACTIVE'`;
      const inactive = (r: Row) =>
        isLocationInactive({
          status: r.status,
          expectedStart: r.expectedStart,
          lastSeenAt: r.lastSeenAt,
          hasDevice: r.hasDevice,
          now,
        });

      // Counts for the status chips, for everything except the status filter itself.
      const grouped = await tx.query<{ status: string; n: number }>(
        `SELECT r.status, count(*)::int AS n FROM attendance_result r JOIN employee e ON e.id = r.employee_id
          WHERE ${base} GROUP BY r.status`,
        params,
      );
      const byStatus = new Map(grouped.rows.map((g) => [g.status, g.n]));
      const counts: Record<string, number> = {
        EXPECTED: ["ON_TIME", "LATE", "EXCUSED", "NO_SHOW", "PENDING"].reduce(
          (n, s) => n + (byStatus.get(s) ?? 0),
          0,
        ),
        ON_TIME: byStatus.get("ON_TIME") ?? 0,
        LATE: byStatus.get("LATE") ?? 0,
        EXCUSED: byStatus.get("EXCUSED") ?? 0,
        NO_SHOW: byStatus.get("NO_SHOW") ?? 0,
        PENDING: byStatus.get("PENDING") ?? 0,
        // Came on a holiday or a day off (PRD 6.1): listed apart, not part of EXPECTED.
        WORKED_OFF_DAY: byStatus.get("WORKED_OFF_DAY") ?? 0,
      };
      const early = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attendance_result r JOIN employee e ON e.id = r.employee_id
          WHERE ${base} AND r.early_leave_minutes > 0`,
        params,
      );
      counts.EARLY_LEAVE = early.rows[0]!.n;
      const silent = await tx.query<Row>(
        `${select} WHERE ${base} AND r.status IN ('PENDING', 'NO_SHOW') LIMIT ${INACTIVE_CAP}`,
        params,
      );
      const inactiveRows = silent.rows.filter(inactive);
      counts.INACTIVE = inactiveRows.length;

      const withFlag = (rows: Row[]) => rows.map((r) => ({ ...r, locationInactive: inactive(r) }));
      if (f.status === "INACTIVE") {
        const sorted = [...inactiveRows].sort((a, b) =>
          String(a.employeeNo).localeCompare(String(b.employeeNo)),
        );
        return {
          date: f.date,
          total: sorted.length,
          limit: f.limit,
          offset: f.offset,
          counts,
          items: withFlag(sorted.slice(f.offset, f.offset + f.limit)),
        };
      }
      const rowWhere = [base];
      if (f.status === "EXPECTED") rowWhere.push(`r.status IN ${EXPECTED_STATUSES}`);
      else if (f.status === "EARLY_LEAVE") rowWhere.push("r.early_leave_minutes > 0");
      else if (f.status) {
        params.push(f.status);
        rowWhere.push(`r.status = $${params.length}`);
      }
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attendance_result r JOIN employee e ON e.id = r.employee_id WHERE ${rowWhere.join(" AND ")}`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows } = await tx.query<Row>(
        `${select} WHERE ${rowWhere.join(" AND ")} ORDER BY e.employee_no
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        date: f.date,
        total: total.rows[0]!.n,
        limit: f.limit,
        offset: f.offset,
        counts,
        items: withFlag(rows),
      };
    });
  }
}
