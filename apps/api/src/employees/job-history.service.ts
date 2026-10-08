import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import type { Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { JOB_KINDS, type JobKind } from "./job-kinds";

const pgCode = (error: unknown) => (error as { code?: string })?.code;

export interface AssignInput {
  /** The new rank / position as free text; `null` ends the current period without a successor. */
  title: string | null;
  /** Defaults to today; must not be in the future. */
  effectiveDate?: string;
  note?: string | null;
}

/**
 * Effective-dated rank / position history of one employee (PRD 12, 22.1). The two histories are independent:
 * a promotion does not touch the position and a transfer does not touch the rank. The values are free text, so any
 * organization can use its own wording. Visibility (data scope) is checked by the caller.
 */
@Injectable()
export class JobHistoryService {
  constructor(private readonly audit: AuditService) {}

  async history(tx: Db, kind: JobKind, employeeId: string) {
    const k = JOB_KINDS[kind];
    const { rows } = await tx.query(
      `SELECT a.id, a.title AS "${kind}", a.valid_from::text AS "validFrom", a.valid_to::text AS "validTo",
              a.note, a.created_at AS "createdAt"
         FROM ${k.assignment} a WHERE a.employee_id = $1 ORDER BY a.valid_from DESC`,
      [employeeId],
    );
    return rows;
  }

  /**
   * Gives the employee a new rank/position from `effectiveDate`: the open period ends that day and a new one starts
   * (or only ends, for `null`). Choosing what they already hold (ignoring case) is a conflict; so is a date that is
   * not after the current start.
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
    const title = input.title === null ? null : input.title.trim().replace(/\s+/gu, " ");
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
      await tx.query<{ id: string; title: string; validFrom: string; validTo: string | null }>(
        `SELECT id, title, valid_from::text AS "validFrom", valid_to::text AS "validTo"
           FROM ${k.assignment} WHERE employee_id = $1 ORDER BY valid_from DESC LIMIT 1 FOR UPDATE`,
        [employee.id],
      )
    ).rows[0];

    if (latest && latest.validTo === null) {
      if (title !== null && latest.title.toLowerCase() === title.toLowerCase()) {
        throw new ApiError(409, `${k.code}_UNCHANGED`, `The employee already has this ${k.label}.`);
      }
      if (effective === latest.validFrom) {
        // A correction on the day the current value was set: nothing was in force yet, so change it in place.
        if (title === null)
          await tx.query(`DELETE FROM ${k.assignment} WHERE id = $1`, [latest.id]);
        else
          await tx.query(`UPDATE ${k.assignment} SET title = $2, note = $3 WHERE id = $1`, [
            latest.id,
            title,
            input.note ?? null,
          ]);
        await this.recordChange(
          tx,
          auth,
          kind,
          employee.id,
          latest,
          title,
          effective,
          input.note ?? null,
          meta,
        );
        return latest.id;
      }
      if (effective < latest.validFrom) {
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
    } else if (title === null) {
      throw new ApiError(409, `${k.code}_NOT_SET`, `The employee has no ${k.label} to remove.`);
    } else if (latest && latest.validTo !== null && effective < latest.validTo) {
      throw new ApiError(
        409,
        "EFFECTIVE_DATE_NOT_AFTER_CURRENT",
        `The effective date overlaps the previous ${k.label} period.`,
        { previousUntil: latest.validTo },
      );
    }

    let id: string | null = null;
    if (title !== null) {
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO ${k.assignment} (tenant_id, employee_id, title, valid_from, note, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [auth.tenantId, employee.id, title, effective, input.note ?? null, auth.userId],
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
        if (pgCode(error) === "23514") {
          throw new ApiError(400, "TITLE_INVALID", `The ${k.label} must be 1–120 characters.`);
        }
        throw error;
      }
    }
    await this.recordChange(
      tx,
      auth,
      kind,
      employee.id,
      latest,
      title,
      effective,
      input.note ?? null,
      meta,
    );
    return id;
  }

  private async recordChange(
    tx: Db,
    auth: AuthContext,
    kind: JobKind,
    employeeId: string,
    latest: { title: string; validFrom: string } | undefined,
    title: string | null,
    effective: string,
    note: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record(tx, {
      tenantId: auth.tenantId,
      action: JOB_KINDS[kind].auditAction,
      actorUserId: auth.userId,
      actorRole: auth.role,
      entityType: "employee",
      entityId: employeeId,
      before: latest ? { [kind]: latest.title, from: latest.validFrom } : null,
      after: { [kind]: title, from: effective, note },
      ...meta,
    });
  }

  /** Distinct values already used in the organization, for the suggestion lists of the text fields. */
  async suggestions(tx: Db, kind: JobKind): Promise<string[]> {
    const k = JOB_KINDS[kind];
    const { rows } = await tx.query<{ title: string }>(
      `SELECT min(title) AS title FROM ${k.assignment} GROUP BY lower(title) ORDER BY lower(title) LIMIT 500`,
    );
    return rows.map((r) => r.title);
  }
}
