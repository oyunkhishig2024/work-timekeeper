import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import type { Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { JOB_KINDS, type JobKind } from "./job-kinds";

const pgCode = (error: unknown) => (error as { code?: string })?.code;

export interface AssignInput {
  catalogId: string;
  /** Defaults to today; must not be in the future. */
  effectiveDate?: string;
  note?: string | null;
}

/**
 * Effective-dated rank / position history of one employee (PRD 12, 22.1). The two histories are independent:
 * a promotion does not touch the position and a transfer does not touch the rank.
 * Visibility (data scope) is checked by the caller; this class only enforces the history rules.
 */
@Injectable()
export class JobHistoryService {
  constructor(private readonly audit: AuditService) {}

  async history(tx: Db, kind: JobKind, employeeId: string) {
    const k = JOB_KINDS[kind];
    const { rows } = await tx.query(
      `SELECT a.id, a.${k.catalogColumn} AS "${kind}Id", c.name AS "${kind}Name",
              a.valid_from::text AS "validFrom", a.valid_to::text AS "validTo", a.note,
              a.created_at AS "createdAt"
         FROM ${k.assignment} a
         JOIN ${k.catalog} c ON c.tenant_id = a.tenant_id AND c.id = a.${k.catalogColumn}
        WHERE a.employee_id = $1
        ORDER BY a.valid_from DESC`,
      [employeeId],
    );
    return rows;
  }

  /**
   * Gives the employee a new rank/position from `effectiveDate`: the open period ends that day and a new one
   * starts. Choosing the one they already hold is a conflict; so is a date that is not after the current start.
   */
  async assign(
    tx: Db,
    auth: AuthContext,
    kind: JobKind,
    employee: { id: string; startDate: string | null },
    input: AssignInput,
    today: string,
    meta: RequestMeta,
  ) {
    const k = JOB_KINDS[kind];
    const catalog = await tx.query<{ name: string; active: boolean }>(
      `SELECT name, active FROM ${k.catalog} WHERE id = $1`,
      [input.catalogId],
    );
    const chosen = catalog.rows[0];
    if (!chosen) {
      throw new ApiError(400, `${k.code}_NOT_FOUND`, `The ${k.label} does not exist.`);
    }
    if (!chosen.active) {
      throw new ApiError(400, `${k.code}_INACTIVE`, `The ${k.label} is inactive.`);
    }
    const effective = input.effectiveDate ?? today;
    if (effective > today) {
      throw new ApiError(
        400,
        "EFFECTIVE_DATE_IN_FUTURE",
        "A future effective date is not supported; use today or a past date.",
      );
    }
    if (employee.startDate && effective < employee.startDate) {
      throw new ApiError(
        400,
        "EFFECTIVE_DATE_BEFORE_START",
        "The effective date is before the employee's start date.",
      );
    }

    const latest = (
      await tx.query<{ id: string; catalogId: string; validFrom: string; validTo: string | null }>(
        `SELECT id, ${k.catalogColumn} AS "catalogId", valid_from::text AS "validFrom", valid_to::text AS "validTo"
           FROM ${k.assignment} WHERE employee_id = $1 ORDER BY valid_from DESC LIMIT 1 FOR UPDATE`,
        [employee.id],
      )
    ).rows[0];

    if (latest && latest.validTo === null) {
      if (latest.catalogId === input.catalogId) {
        throw new ApiError(409, `${k.code}_UNCHANGED`, `The employee already has this ${k.label}.`);
      }
      if (effective <= latest.validFrom) {
        throw new ApiError(
          409,
          "EFFECTIVE_DATE_NOT_AFTER_CURRENT",
          `The effective date must be after the current ${k.label} started.`,
          { currentFrom: latest.validFrom },
        );
      }
      await tx.query(`UPDATE ${k.assignment} SET valid_to = $2 WHERE id = $1`, [
        latest.id,
        effective,
      ]);
    } else if (latest && latest.validTo !== null && effective < latest.validTo) {
      throw new ApiError(
        409,
        "EFFECTIVE_DATE_NOT_AFTER_CURRENT",
        `The effective date overlaps the previous ${k.label} period.`,
        { previousUntil: latest.validTo },
      );
    }

    let id: string;
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ${k.assignment} (tenant_id, employee_id, ${k.catalogColumn}, valid_from, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [auth.tenantId, employee.id, input.catalogId, effective, input.note ?? null, auth.userId],
      );
      id = rows[0]!.id;
    } catch (error) {
      if (pgCode(error) === "23P01") {
        throw new ApiError(
          409,
          "HISTORY_CONFLICT",
          `The ${k.label} history already covers this date.`,
        );
      }
      throw error;
    }
    await this.audit.record(tx, {
      tenantId: auth.tenantId,
      action: k.auditAction,
      actorUserId: auth.userId,
      actorRole: auth.role,
      entityType: "employee",
      entityId: employee.id,
      before: latest ? { [`${kind}Id`]: latest.catalogId, from: latest.validFrom } : null,
      after: {
        [`${kind}Id`]: input.catalogId,
        name: chosen.name,
        from: effective,
        note: input.note ?? null,
      },
      ...meta,
    });
    return id;
  }
}
