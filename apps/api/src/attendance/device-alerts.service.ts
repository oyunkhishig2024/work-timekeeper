import { Injectable } from "@nestjs/common";
import { ScopeService } from "../access/scope.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { DatabaseService } from "../database/database.service";

const COLUMNS = `a.id, a.kind, a.detail, a.created_at AS "createdAt",
  a.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName",
  a.device_id AS "deviceId", d.model, d.platform, d.last_batch_verdict AS "lastBatchVerdict",
  d.attestation_unavailable_streak AS "unavailableStreak",
  a.related_employee_id AS "relatedEmployeeId", re.employee_no AS "relatedEmployeeNo", re.full_name AS "relatedFullName",
  a.resolved_at AS "resolvedAt", COALESCE(ru.display_name, ru.username) AS "resolvedByName",
  a.resolution_note AS "resolutionNote"`;
const FROM = `device_alert a
  JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
  JOIN device d ON d.tenant_id = a.tenant_id AND d.id = a.device_id
  LEFT JOIN employee re ON re.tenant_id = a.tenant_id AND re.id = a.related_employee_id
  LEFT JOIN user_account ru ON ru.tenant_id = a.tenant_id AND ru.id = a.resolved_by`;

/** What HR follows up (PRD 6.7): silent attestation, and one device or movement shared by two employees. */
@Injectable()
export class DeviceAlertsService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async list(
    auth: AuthContext,
    f: { status: "OPEN" | "ALL"; kind?: string; limit: number; offset: number },
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const where = [this.scopes.employeeCondition(scope, "e", params)];
      if (f.status === "OPEN") where.push("a.resolved_at IS NULL");
      if (f.kind) {
        params.push(f.kind);
        where.push(`a.kind = $${params.length}`);
      }
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${FROM} WHERE ${where.join(" AND ")}`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows } = await tx.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(" AND ")}
          ORDER BY a.created_at DESC, a.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: total.rows[0]!.n, limit: f.limit, offset: f.offset, items: rows };
    });
  }

  async resolve(auth: AuthContext, id: string, note: string | undefined, meta: RequestMeta) {
    const now = this.clock.now();
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [id];
      const cond = this.scopes.employeeCondition(scope, "e", params);
      const found = await tx.query<{ resolvedAt: Date | null; kind: string }>(
        `SELECT a.resolved_at AS "resolvedAt", a.kind FROM ${FROM} WHERE a.id = $1 AND ${cond} FOR UPDATE OF a`,
        params,
      );
      const alert = found.rows[0];
      if (!alert) throw new ApiError(404, "ALERT_NOT_FOUND", "No such alert.");
      if (alert.resolvedAt)
        throw new ApiError(409, "ALREADY_RESOLVED", "This alert is already resolved.");
      await tx.query(
        "UPDATE device_alert SET resolved_at = $2, resolved_by = $3, resolution_note = $4 WHERE id = $1",
        [id, now, auth.userId, note?.trim() || null],
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "device.alert_resolved",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "device_alert",
        entityId: id,
        after: { kind: alert.kind, note: note ?? null },
        ...meta,
      });
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE a.id = $1`, [id]);
      return rows[0];
    });
  }
}
