import { Injectable } from "@nestjs/common";
import { addDays, correctionProblem, daysBetween } from "@timekeeper/domain";
import { ScopeService } from "../access/scope.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { notifyOrgAdmins } from "../notifications/enqueue";
import { AttendanceService } from "./attendance.service";

/** PRD 6.9 defaults: corrections only for the last 31 days; more than 10 by one user in a day is reported. */
export const CORRECTION_WINDOW_DAYS = 31;
export const CORRECTION_ALERT_PER_DAY = 10;
const MAX_REPORT_DAYS = 366;

export const CORRECTION_REASONS = [
  "PHONE_DEAD_LOST",
  "GPS_FAULT",
  "APP_ISSUE",
  "ANOMALY_REVIEW",
  "DATA_ENTRY_ERROR",
  "OTHER",
] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

export interface CorrectionInput {
  employeeId: string;
  workDate: string;
  status: "ON_TIME" | "LATE" | "NO_SHOW";
  arrivalAt?: Date | null;
  reasonCode: CorrectionReason;
  note?: string | null;
}

export interface CorrectionFilter {
  from: string;
  to: string;
  employeeId?: string;
  actorId?: string;
  reasonCode?: CorrectionReason;
  locationId?: string;
  includeRevoked: boolean;
  limit: number;
  offset: number;
}

const LIST_COLUMNS = `c.id, c.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName",
  c.work_date::text AS "workDate", c.status, c.arrival_at AS "arrivalAt", c.reason_code AS "reasonCode", c.note,
  c.original_status AS "originalStatus", c.original_arrival_at AS "originalArrivalAt",
  c.created_by AS "createdBy", COALESCE(u.display_name, u.username) AS "createdByName", c.created_at AS "createdAt",
  c.revoked_at AS "revokedAt", c.revoke_note AS "revokeNote",
  COALESCE(r.location_id, e.primary_location_id) AS "locationId"`;
const LIST_FROM = `attendance_correction c
  JOIN employee e ON e.tenant_id = c.tenant_id AND e.id = c.employee_id
  JOIN user_account u ON u.tenant_id = c.tenant_id AND u.id = c.created_by
  LEFT JOIN attendance_result r ON r.tenant_id = c.tenant_id AND r.employee_id = c.employee_id AND r.work_date = c.work_date`;

/**
 * Manual attendance corrections (PRD 6.9). A correction is stored apart from the system result and layered over it by
 * `applyCorrection` (packages/domain) inside the attendance engine; this service validates, records, audits and asks the
 * engine to rebuild the day. HR and Org Admin apply them directly, no second approval.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
    private readonly attendance: AttendanceService,
  ) {}

  async create(auth: AuthContext, input: CorrectionInput, meta: RequestMeta) {
    const problem = correctionProblem({ status: input.status, arrivalAt: input.arrivalAt ?? null });
    if (problem) {
      throw new ApiError(
        400,
        "NO_SHOW_WITH_ARRIVAL",
        "An arrival time cannot be given for Ирээгүй.",
      );
    }
    const now = this.clock.now();
    return this.db.withTenant(auth.tenantId, async (tx) => {
      await this.assertWindow(tx, auth.tenantId, input.workDate);
      await this.assertInScope(tx, auth, input.employeeId);
      // Always correct on top of a fresh system value.
      await this.attendance.recompute(
        tx,
        auth.tenantId,
        [input.employeeId],
        input.workDate,
        input.workDate,
        now,
      );
      const day = await tx.query<{
        systemStatus: string;
        systemArrivalAt: Date | null;
        expectedStart: Date | null;
        correctionId: string | null;
      }>(
        `SELECT system_status AS "systemStatus", system_arrival_at AS "systemArrivalAt",
                expected_start AS "expectedStart", correction_id AS "correctionId"
           FROM attendance_result WHERE employee_id = $1 AND work_date = $2 FOR UPDATE`,
        [input.employeeId, input.workDate],
      );
      const row = day.rows[0];
      if (!row || row.expectedStart === null) {
        throw new ApiError(
          409,
          "NOT_AN_EXPECTED_DAY",
          "Nobody is expected to attend on this date, so there is nothing to correct.",
        );
      }
      if (input.arrivalAt) {
        if (input.arrivalAt.getTime() > now.getTime()) {
          throw new ApiError(400, "ARRIVAL_IN_FUTURE", "The arrival time is in the future.");
        }
        if (Math.abs(input.arrivalAt.getTime() - row.expectedStart.getTime()) > 24 * 3_600_000) {
          throw new ApiError(
            400,
            "ARRIVAL_OUT_OF_RANGE",
            "The arrival time is not near this duty.",
          );
        }
      }
      let replaced: string | null = null;
      if (row.correctionId) {
        replaced = row.correctionId;
        await tx.query(
          "UPDATE attendance_correction SET revoked_at = $2, revoked_by = $3, revoke_note = 'REPLACED' WHERE id = $1",
          [row.correctionId, now, auth.userId],
        );
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO attendance_correction (tenant_id, employee_id, work_date, status, arrival_at, reason_code, note,
                                            original_status, original_arrival_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          auth.tenantId,
          input.employeeId,
          input.workDate,
          input.status,
          input.arrivalAt ?? null,
          input.reasonCode,
          input.note?.trim() || null,
          row.systemStatus,
          row.systemArrivalAt,
          auth.userId,
          now,
        ],
      );
      const id = inserted.rows[0]!.id;
      await this.attendance.recompute(
        tx,
        auth.tenantId,
        [input.employeeId],
        input.workDate,
        input.workDate,
        now,
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: replaced ? "attendance.correction_replaced" : "attendance.correction_created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "attendance_correction",
        entityId: id,
        before: {
          status: row.systemStatus,
          arrivalAt: row.systemArrivalAt,
          replacedCorrectionId: replaced,
        },
        after: {
          employeeId: input.employeeId,
          workDate: input.workDate,
          status: input.status,
          arrivalAt: input.arrivalAt ?? null,
          reasonCode: input.reasonCode,
          note: input.note ?? null,
        },
        ...meta,
      });
      await this.alertOnVolume(tx, auth, now);
      return this.one(tx, id);
    });
  }

  /** PRD 6.9: more than 10 corrections by one user in a day goes to the Org Admin (once per user and day). */
  private async alertOnVolume(tx: Db, auth: AuthContext, now: Date) {
    const tz =
      (
        await tx.query<{ time_zone: string }>("SELECT time_zone FROM tenant WHERE id = $1", [
          auth.tenantId,
        ])
      ).rows[0]?.time_zone ?? "Asia/Ulaanbaatar";
    const { rows } = await tx.query<{ n: number; day: string }>(
      `SELECT count(*)::int AS n, ($2::timestamptz AT TIME ZONE $3)::date::text AS day FROM attendance_correction
        WHERE created_by = $1 AND (created_at AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date`,
      [auth.userId, now, tz],
    );
    if (rows[0]!.n > CORRECTION_ALERT_PER_DAY) {
      await notifyOrgAdmins(tx, auth.tenantId, {
        kind: "CORRECTION_VOLUME",
        title: "Ирцийн засвар ихээр хийгдлээ",
        body: `Нэг хэрэглэгч өнөөдөр ${CORRECTION_ALERT_PER_DAY}-аас олон ирцийн засвар хийлээ. Засварын тайланг шалгана уу.`,
        link: "/corrections/report",
        dedupeKey: `correction-volume:${auth.userId}:${rows[0]!.day}`,
      });
    }
  }

  async revoke(auth: AuthContext, id: string, note: string | undefined, meta: RequestMeta) {
    const now = this.clock.now();
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{
        employeeId: string;
        workDate: string;
        revokedAt: Date | null;
      }>(
        `SELECT employee_id AS "employeeId", work_date::text AS "workDate", revoked_at AS "revokedAt"
           FROM attendance_correction WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const c = found.rows[0];
      if (!c) throw new ApiError(404, "CORRECTION_NOT_FOUND", "No such correction.");
      await this.assertInScope(tx, auth, c.employeeId);
      if (c.revokedAt)
        throw new ApiError(409, "ALREADY_REVOKED", "This correction is already revoked.");
      await this.assertWindow(tx, auth.tenantId, c.workDate);
      await tx.query(
        "UPDATE attendance_correction SET revoked_at = $2, revoked_by = $3, revoke_note = $4 WHERE id = $1",
        [id, now, auth.userId, note?.trim() || null],
      );
      await this.attendance.recompute(
        tx,
        auth.tenantId,
        [c.employeeId],
        c.workDate,
        c.workDate,
        now,
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "attendance.correction_revoked",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "attendance_correction",
        entityId: id,
        after: { employeeId: c.employeeId, workDate: c.workDate, note: note ?? null },
        ...meta,
      });
      return this.one(tx, id);
    });
  }

  async list(auth: AuthContext, f: CorrectionFilter) {
    if (daysBetween(f.from, f.to) < 0)
      throw new ApiError(400, "INVALID_DATES", "`to` is before `from`.");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [f.from, f.to];
      const where = [
        "c.work_date BETWEEN $1 AND $2",
        this.scopes.employeeCondition(scope, "e", params),
      ];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (!f.includeRevoked) where.push("c.revoked_at IS NULL");
      if (f.employeeId) add("c.employee_id = ?", f.employeeId);
      if (f.actorId) add("c.created_by = ?", f.actorId);
      if (f.reasonCode) add("c.reason_code = ?", f.reasonCode);
      if (f.locationId) add("COALESCE(r.location_id, e.primary_location_id) = ?", f.locationId);
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${LIST_FROM} WHERE ${where.join(" AND ")}`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows } = await tx.query(
        `SELECT ${LIST_COLUMNS} FROM ${LIST_FROM} WHERE ${where.join(" AND ")}
          ORDER BY c.created_at DESC, c.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: total.rows[0]!.n, limit: f.limit, offset: f.offset, items: rows };
    });
  }

  /**
   * Monthly Corrections report for the Org Admin (PRD 6.9, 18): by actor, reason and location, the share of expected
   * duties that were corrected (a data-quality indicator), and the alerts (a user with more than 10 corrections a day).
   */
  async report(auth: AuthContext, from: string, to: string) {
    const days = daysBetween(from, to) + 1;
    if (days < 1) throw new ApiError(400, "INVALID_DATES", "`to` is before `from`.");
    if (days > MAX_REPORT_DAYS) throw new ApiError(400, "RANGE_TOO_LONG", "At most 366 days.");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const tz =
        (
          await tx.query<{ time_zone: string }>("SELECT time_zone FROM tenant WHERE id = $1", [
            auth.tenantId,
          ])
        ).rows[0]?.time_zone ?? "Asia/Ulaanbaatar";
      const base = `FROM attendance_correction c JOIN employee e ON e.id = c.employee_id
        LEFT JOIN attendance_result r ON r.employee_id = c.employee_id AND r.work_date = c.work_date
        WHERE c.work_date BETWEEN $1 AND $2`;
      const total = await tx.query<{ made: number; active: number; revoked: number }>(
        `SELECT count(*)::int AS made, count(*) FILTER (WHERE c.revoked_at IS NULL)::int AS active,
                count(*) FILTER (WHERE c.revoked_at IS NOT NULL)::int AS revoked ${base}`,
        [from, to],
      );
      const byActor = await tx.query(
        `SELECT c.created_by AS "userId", COALESCE(u.display_name, u.username) AS name, count(*)::int AS count
           FROM attendance_correction c JOIN user_account u ON u.id = c.created_by
          WHERE c.work_date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY count DESC, name`,
        [from, to],
      );
      const byReason = await tx.query(
        `SELECT c.reason_code AS "reasonCode", count(*)::int AS count ${base} GROUP BY 1 ORDER BY count DESC`,
        [from, to],
      );
      const byLocation = await tx.query(
        `WITH made AS (
           SELECT COALESCE(r.location_id, e.primary_location_id) AS location_id, count(*) AS corrections ${base} AND c.revoked_at IS NULL
           GROUP BY 1
         ), duties AS (
           SELECT location_id, count(*) AS duties FROM attendance_result
            WHERE work_date BETWEEN $1 AND $2 AND status NOT IN ('WORKED_OFF_DAY', 'NOT_CONFIGURED') AND location_id IS NOT NULL
            GROUP BY 1
         )
         SELECT l.id AS "locationId", l.name, made.corrections::int AS corrections, COALESCE(duties.duties, 0)::int AS duties,
                CASE WHEN COALESCE(duties.duties, 0) = 0 THEN 0
                     ELSE round(made.corrections * 1000.0 / duties.duties) / 10 END::float AS "ratePct"
           FROM made JOIN location l ON l.id = made.location_id LEFT JOIN duties ON duties.location_id = made.location_id
          ORDER BY "ratePct" DESC, l.name`,
        [from, to],
      );
      const alerts = await tx.query(
        `SELECT c.created_by AS "userId", COALESCE(u.display_name, u.username) AS name,
                (c.created_at AT TIME ZONE $3)::date::text AS date, count(*)::int AS count
           FROM attendance_correction c JOIN user_account u ON u.id = c.created_by
          WHERE c.work_date BETWEEN $1 AND $2
          GROUP BY 1, 2, 3 HAVING count(*) > ${CORRECTION_ALERT_PER_DAY} ORDER BY date DESC, count DESC`,
        [from, to, tz],
      );
      return {
        from,
        to,
        ...total.rows[0]!,
        byActor: byActor.rows,
        byReason: byReason.rows,
        byLocation: byLocation.rows,
        alerts: alerts.rows,
        alertThresholdPerDay: CORRECTION_ALERT_PER_DAY,
      };
    });
  }

  private async one(tx: Db, id: string) {
    const { rows } = await tx.query(`SELECT ${LIST_COLUMNS} FROM ${LIST_FROM} WHERE c.id = $1`, [
      id,
    ]);
    return rows[0];
  }

  private async assertWindow(tx: Db, tenantId: string, workDate: string) {
    const today = await tenantToday(tx, this.clock, tenantId);
    if (workDate > today) {
      throw new ApiError(409, "DATE_IN_FUTURE", "A correction cannot be made for a future date.");
    }
    if (workDate < addDays(today, -CORRECTION_WINDOW_DAYS)) {
      throw new ApiError(
        409,
        "CORRECTION_WINDOW_CLOSED",
        `Corrections are possible for the last ${CORRECTION_WINDOW_DAYS} days only.`,
      );
    }
  }

  private async assertInScope(tx: Db, auth: AuthContext, employeeId: string) {
    const scope = await this.scopes.forUser(tx, auth);
    const params: unknown[] = [employeeId];
    const cond = this.scopes.employeeCondition(scope, "e", params);
    const { rows } = await tx.query(`SELECT 1 FROM employee e WHERE e.id = $1 AND ${cond}`, params);
    if (rows.length === 0) throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "No such employee.");
  }
}
