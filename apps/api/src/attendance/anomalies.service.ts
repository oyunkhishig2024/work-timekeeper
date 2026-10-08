import { Injectable } from "@nestjs/common";
import { candidateWorkDates } from "@timekeeper/domain";
import { ScopeService } from "../access/scope.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { DatabaseService, type Db } from "../database/database.service";
import { AttendanceService, REVIEW_FLAGS } from "./attendance.service";

/** PRD 6.7: three flagged events within seven days raise a flag on the employee. */
export const REPEAT_THRESHOLD = 3;
export const REPEAT_DAYS = 7;

export type ReviewStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "RECHECK_REQUESTED";
export type ReviewDecision = "CONFIRM" | "REJECT" | "REQUEST_RECHECK";

export interface AnomalyFilter {
  /** OPEN = PENDING + RECHECK_REQUESTED (the queue); ALL includes decided ones. */
  status: "OPEN" | ReviewStatus | "ALL";
  from?: Date;
  to?: Date;
  employeeId?: string;
  limit: number;
  offset: number;
}

const COLUMNS = `ev.id, ev.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName",
  d.name AS "departmentName", l.id AS "locationId", l.name AS "locationName",
  ev.type, ev.occurred_at AS "occurredAt", ev.received_at AS "receivedAt", ev.claimed_at AS "claimedAt",
  ev.accuracy_m::float AS "accuracyM", ev.flags, ev.counted,
  ev.review_status AS "reviewStatus", ev.reviewed_at AS "reviewedAt", ev.review_note AS "reviewNote",
  COALESCE(rb.display_name, rb.username) AS "reviewedByName"`;
const FROM = `device_event ev
  JOIN employee e ON e.tenant_id = ev.tenant_id AND e.id = ev.employee_id
  LEFT JOIN department d ON d.id = e.department_id
  JOIN location l ON l.tenant_id = ev.tenant_id AND l.id = ev.location_id
  LEFT JOIN user_account rb ON rb.tenant_id = ev.tenant_id AND rb.id = ev.reviewed_by`;

/**
 * Anomaly Review Queue (PRD 6.7). Suspicious events are accepted and flagged when they arrive; HR then confirms
 * (clears the flag), rejects (the event stops counting and the day is rebuilt) or asks for a re-check. Every decision
 * is audited.
 */
@Injectable()
export class AnomaliesService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
    private readonly attendance: AttendanceService,
  ) {}

  async list(auth: AuthContext, f: AnomalyFilter) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const where = [this.scopes.employeeCondition(scope, "e", params)];
      params.push([...REVIEW_FLAGS]);
      where.push(`ev.flags && $${params.length}::text[]`);
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.status === "OPEN") where.push("ev.review_status IN ('PENDING', 'RECHECK_REQUESTED')");
      else if (f.status !== "ALL") add("ev.review_status = ?", f.status);
      if (f.employeeId) add("ev.employee_id = ?", f.employeeId);
      if (f.from) add("ev.occurred_at >= ?", f.from);
      if (f.to) add("ev.occurred_at < ?", f.to);
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${FROM} WHERE ${where.join(" AND ")}`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows } = await tx.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(" AND ")}
          ORDER BY ev.occurred_at DESC, ev.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        total: total.rows[0]!.n,
        limit: f.limit,
        offset: f.offset,
        items: rows,
        repeated: await this.repeated(tx, auth),
      };
    });
  }

  /** Employees with at least three flagged events in the last seven days (PRD 6.7), inside the caller's scope. */
  private async repeated(tx: Db, auth: AuthContext) {
    const scope = await this.scopes.forUser(tx, auth);
    const params: unknown[] = [
      [...REVIEW_FLAGS],
      new Date(this.clock.now().getTime() - REPEAT_DAYS * 86_400_000),
    ];
    const cond = this.scopes.employeeCondition(scope, "e", params);
    const { rows } = await tx.query(
      `SELECT e.id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName", count(*)::int AS count
         FROM device_event ev JOIN employee e ON e.id = ev.employee_id
        WHERE ev.flags && $1::text[] AND ev.occurred_at >= $2 AND ${cond}
        GROUP BY 1, 2, 3 HAVING count(*) >= ${REPEAT_THRESHOLD} ORDER BY count DESC, "employeeNo"`,
      params,
    );
    return { threshold: REPEAT_THRESHOLD, days: REPEAT_DAYS, employees: rows };
  }

  async review(
    auth: AuthContext,
    eventId: string,
    decision: ReviewDecision,
    note: string | undefined,
    meta: RequestMeta,
  ) {
    const now = this.clock.now();
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{
        employeeId: string;
        occurredAt: Date;
        flags: string[];
        reviewStatus: ReviewStatus | null;
        counted: boolean;
      }>(
        `SELECT employee_id AS "employeeId", occurred_at AS "occurredAt", flags, review_status AS "reviewStatus", counted
           FROM device_event WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const ev = found.rows[0];
      if (!ev) throw new ApiError(404, "EVENT_NOT_FOUND", "No such event.");
      const scope = await this.scopes.forUser(tx, auth);
      const check: unknown[] = [ev.employeeId];
      const inScope = await tx.query(
        `SELECT 1 FROM employee e WHERE e.id = $1 AND ${this.scopes.employeeCondition(scope, "e", check)}`,
        check,
      );
      if (inScope.rows.length === 0) throw new ApiError(404, "EVENT_NOT_FOUND", "No such event.");
      if (ev.reviewStatus !== "PENDING" && ev.reviewStatus !== "RECHECK_REQUESTED") {
        throw new ApiError(409, "NOT_IN_REVIEW", "This event is not waiting for review.");
      }
      if (decision === "REQUEST_RECHECK" && ev.reviewStatus === "RECHECK_REQUESTED") {
        throw new ApiError(409, "RECHECK_ALREADY_REQUESTED", "A re-check was already requested.");
      }
      const status: ReviewStatus =
        decision === "CONFIRM"
          ? "CONFIRMED"
          : decision === "REJECT"
            ? "REJECTED"
            : "RECHECK_REQUESTED";
      // Confirming clears the suspicion, so an ENTER that was held back only for low accuracy now counts; an event that is
      // too old to sync (LATE_SYNC) never does. Rejecting always removes it from the day.
      const counted =
        decision === "CONFIRM"
          ? !ev.flags.includes("LATE_SYNC")
          : decision === "REJECT"
            ? false
            : ev.counted;
      await tx.query(
        `UPDATE device_event SET review_status = $2, counted = $3, reviewed_by = $4, reviewed_at = $5, review_note = $6
          WHERE id = $1`,
        [eventId, status, counted, auth.userId, now, note?.trim() || null],
      );
      const tz =
        (
          await tx.query<{ time_zone: string }>("SELECT time_zone FROM tenant WHERE id = $1", [
            auth.tenantId,
          ])
        ).rows[0]?.time_zone ?? "Asia/Ulaanbaatar";
      const [previous, current] = candidateWorkDates(ev.occurredAt, tz);
      await this.attendance.recompute(tx, auth.tenantId, [ev.employeeId], previous, current, now);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "attendance.anomaly_reviewed",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "device_event",
        entityId: eventId,
        before: { reviewStatus: ev.reviewStatus, counted: ev.counted, flags: ev.flags },
        after: { decision, reviewStatus: status, counted, note: note ?? null },
        ...meta,
      });
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ev.id = $1`, [eventId]);
      return rows[0];
    });
  }
}
