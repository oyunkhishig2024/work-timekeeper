import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { mapDbError } from "../common/db-errors";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { ScopeService } from "../access/scope.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";

export interface TemplateInput {
  name: string;
  startTime: string;
  durationMinutes: number;
  graceMinutes?: number;
  cutoffMinutes?: number;
  earlyWindowMinutes?: number;
  observesHolidays?: boolean;
}

export interface AssignmentInput {
  items: Array<{ employeeId: string; cycleStartDate?: string }>;
  patternId?: string;
  templateId?: string;
  cycleStartDate?: string;
  fromDate: string;
  toDate?: string | null;
}

const pgCode = (error: unknown) => (error as { code?: string })?.code;

const TEMPLATE_SELECT = `
  t.id, t.name, to_char(t.start_time, 'HH24:MI') AS "startTime", t.duration_minutes AS "durationMinutes",
  to_char(t.start_time + make_interval(mins => t.duration_minutes), 'HH24:MI') AS "endTime",
  (t.start_time + make_interval(mins => t.duration_minutes)) < t.start_time
    OR t.duration_minutes = 1440 AS "endsNextDay",
  t.grace_minutes AS "graceMinutes", t.cutoff_minutes AS "cutoffMinutes",
  t.early_window_minutes AS "earlyWindowMinutes", t.observes_holidays AS "observesHolidays",
  t.active, t.supersedes_id AS "supersedesId", t.created_at AS "createdAt",
  (EXISTS (SELECT 1 FROM shift_pattern_day d WHERE d.tenant_id = t.tenant_id AND d.template_id = t.id)
   OR EXISTS (SELECT 1 FROM shift_assignment a WHERE a.tenant_id = t.tenant_id AND a.template_id = t.id)
   OR EXISTS (SELECT 1 FROM shift_override o WHERE o.tenant_id = t.tenant_id AND o.template_id = t.id)) AS "inUse"`;

/**
 * Shift templates, rotation patterns, assignments and one-day overrides (PRD 23). Timing of a template or
 * pattern that is already used never changes (PRD 22.1): create a new version instead. How a shift turns into
 * "expected on this date" is in packages/domain (`getExpectation`); this service only stores and protects.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
  ) {}

  // ------------------------------------------------------------------ templates (PRD 23.1)

  async listTemplates(auth: AuthContext, filter: { active?: boolean }) {
    return this.db.withTenant(auth.tenantId, (tx) =>
      this.selectTemplates(tx, { active: filter.active }),
    );
  }

  async getTemplate(auth: AuthContext, id: string) {
    const found = await this.db.withTenant(
      auth.tenantId,
      async (tx) => (await this.selectTemplates(tx, { id }))[0],
    );
    if (!found) throw new ApiError(404, "SHIFT_TEMPLATE_NOT_FOUND", "Shift template not found.");
    return found;
  }

  private async selectTemplates(tx: Db, f: { id?: string; active?: boolean }) {
    const { rows } = await tx.query(
      `SELECT ${TEMPLATE_SELECT} FROM shift_template t
        WHERE ($1::uuid IS NULL OR t.id = $1) AND ($2::boolean IS NULL OR t.active = $2)
        ORDER BY t.active DESC, t.name, t.created_at`,
      [f.id ?? null, f.active ?? null],
    );
    return rows;
  }

  async createTemplate(auth: AuthContext, input: TemplateInput, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const id = await this.insertTemplate(tx, auth, input, null);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "shift_template.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "shift_template",
        entityId: id,
        after: input,
        ...meta,
      });
      return (await this.selectTemplates(tx, { id }))[0];
    });
  }

  /** Name and active flag can always change; timing only while the template is unused (else `409 SHIFT_TEMPLATE_IN_USE`). */
  async updateTemplate(
    auth: AuthContext,
    id: string,
    input: Partial<TemplateInput> & { active?: boolean },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const before = (await this.selectTemplates(tx, { id }))[0] as
        Record<string, unknown> | undefined;
      if (!before) throw new ApiError(404, "SHIFT_TEMPLATE_NOT_FOUND", "Shift template not found.");
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (input.name !== undefined) set("name", input.name);
      if (input.active !== undefined) set("active", input.active);
      if (input.startTime !== undefined) set("start_time", input.startTime);
      if (input.durationMinutes !== undefined) set("duration_minutes", input.durationMinutes);
      if (input.graceMinutes !== undefined) set("grace_minutes", input.graceMinutes);
      if (input.cutoffMinutes !== undefined) set("cutoff_minutes", input.cutoffMinutes);
      if (input.earlyWindowMinutes !== undefined)
        set("early_window_minutes", input.earlyWindowMinutes);
      if (input.observesHolidays !== undefined) set("observes_holidays", input.observesHolidays);
      try {
        await tx.query(`UPDATE shift_template SET ${sets.join(", ")} WHERE id = $1`, params);
      } catch (error) {
        throw this.mapTemplateError(error);
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "shift_template.updated",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "shift_template",
        entityId: id,
        before: before,
        after: input,
        ...meta,
      });
      return (await this.selectTemplates(tx, { id }))[0];
    });
  }

  /** A used template keeps its timing forever: this retires it and creates a new one that supersedes it. */
  async supersedeTemplate(
    auth: AuthContext,
    id: string,
    input: Partial<TemplateInput>,
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const old = (await this.selectTemplates(tx, { id }))[0] as
        (TemplateInput & { active: boolean }) | undefined;
      if (!old) throw new ApiError(404, "SHIFT_TEMPLATE_NOT_FOUND", "Shift template not found.");
      if (!old.active) {
        throw new ApiError(409, "SHIFT_TEMPLATE_RETIRED", "The template is already retired.");
      }
      // Retire first: active template names are unique, and the new version usually keeps the name.
      await tx.query("UPDATE shift_template SET active = false WHERE id = $1", [id]);
      const merged: TemplateInput = {
        name: input.name ?? old.name,
        startTime: input.startTime ?? old.startTime,
        durationMinutes: input.durationMinutes ?? old.durationMinutes,
        graceMinutes: input.graceMinutes ?? old.graceMinutes,
        cutoffMinutes: input.cutoffMinutes ?? old.cutoffMinutes,
        earlyWindowMinutes: input.earlyWindowMinutes ?? old.earlyWindowMinutes,
        observesHolidays: input.observesHolidays ?? old.observesHolidays,
      };
      const newId = await this.insertTemplate(tx, auth, merged, id);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "shift_template.superseded",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "shift_template",
        entityId: newId,
        before: old,
        after: merged,
        ...meta,
      });
      return (await this.selectTemplates(tx, { id: newId }))[0];
    });
  }

  private async insertTemplate(
    tx: Db,
    auth: AuthContext,
    t: TemplateInput,
    supersedes: string | null,
  ): Promise<string> {
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO shift_template
           (tenant_id, name, start_time, duration_minutes, grace_minutes, cutoff_minutes, early_window_minutes,
            observes_holidays, supersedes_id, created_by)
         VALUES ($1, $2, $3, $4, COALESCE($5, 15), COALESCE($6, 120), COALESCE($7, 120), COALESCE($8, false), $9, $10)
         RETURNING id`,
        [
          auth.tenantId,
          t.name,
          t.startTime,
          t.durationMinutes,
          t.graceMinutes ?? null,
          t.cutoffMinutes ?? null,
          t.earlyWindowMinutes ?? null,
          t.observesHolidays ?? null,
          supersedes,
          auth.userId,
        ],
      );
      return rows[0]!.id;
    } catch (error) {
      throw this.mapTemplateError(error);
    }
  }

  private mapTemplateError(error: unknown): unknown {
    if (pgCode(error) === "23505") {
      return new ApiError(
        409,
        "SHIFT_TEMPLATE_NAME_TAKEN",
        "An active shift template with this name exists.",
      );
    }
    return mapDbError(error);
  }

  // ------------------------------------------------------------------ patterns (PRD 23.1)

  async listPatterns(auth: AuthContext, filter: { active?: boolean }) {
    return this.db.withTenant(auth.tenantId, (tx) =>
      this.selectPatterns(tx, { active: filter.active }),
    );
  }

  async getPattern(auth: AuthContext, id: string) {
    const found = await this.db.withTenant(
      auth.tenantId,
      async (tx) => (await this.selectPatterns(tx, { id }))[0],
    );
    if (!found) throw new ApiError(404, "SHIFT_PATTERN_NOT_FOUND", "Shift pattern not found.");
    return found;
  }

  private async selectPatterns(tx: Db, f: { id?: string; active?: boolean }) {
    const { rows } = await tx.query(
      `SELECT p.id, p.name, p.cycle_length_days AS "cycleLengthDays", p.active, p.created_at AS "createdAt",
              (SELECT json_agg(d.template_id ORDER BY d.day_index) FROM shift_pattern_day d WHERE d.pattern_id = p.id) AS days,
              EXISTS (SELECT 1 FROM shift_assignment a WHERE a.tenant_id = p.tenant_id AND a.pattern_id = p.id) AS "inUse"
         FROM shift_pattern p
        WHERE ($1::uuid IS NULL OR p.id = $1) AND ($2::boolean IS NULL OR p.active = $2)
        ORDER BY p.active DESC, p.name`,
      [f.id ?? null, f.active ?? null],
    );
    return rows;
  }

  /** `days[i]` is the template for day i of the cycle, or `null` for an off day. The cycle length is `days.length`. */
  async createPattern(
    auth: AuthContext,
    input: { name: string; days: Array<string | null> },
    meta: RequestMeta,
  ) {
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        const ids = [...new Set(input.days.filter((d): d is string => d !== null))];
        if (ids.length === 0) {
          throw new ApiError(
            400,
            "PATTERN_HAS_NO_WORK_DAY",
            "A pattern needs at least one working day.",
          );
        }
        await this.assertActiveTemplates(tx, ids);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO shift_pattern (tenant_id, name, cycle_length_days, created_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [auth.tenantId, input.name, input.days.length, auth.userId],
        );
        const id = rows[0]!.id;
        for (const [index, templateId] of input.days.entries()) {
          await tx.query(
            "INSERT INTO shift_pattern_day (tenant_id, pattern_id, day_index, template_id) VALUES ($1, $2, $3, $4)",
            [auth.tenantId, id, index, templateId],
          );
        }
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "shift_pattern.created",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "shift_pattern",
          entityId: id,
          after: input,
          ...meta,
        });
        return (await this.selectPatterns(tx, { id }))[0];
      });
    } catch (error) {
      if (pgCode(error) === "23505") {
        throw new ApiError(
          409,
          "SHIFT_PATTERN_NAME_TAKEN",
          "An active shift pattern with this name exists.",
        );
      }
      throw mapDbError(error);
    }
  }

  /** Only the name and active flag change; the days of an assigned pattern never do (create a new pattern). */
  async updatePattern(
    auth: AuthContext,
    id: string,
    input: { name?: string; active?: boolean },
    meta: RequestMeta,
  ) {
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        const before = (await this.selectPatterns(tx, { id }))[0];
        if (!before) throw new ApiError(404, "SHIFT_PATTERN_NOT_FOUND", "Shift pattern not found.");
        await tx.query(
          "UPDATE shift_pattern SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1",
          [id, input.name ?? null, input.active ?? null],
        );
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "shift_pattern.updated",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "shift_pattern",
          entityId: id,
          before,
          after: input,
          ...meta,
        });
        return (await this.selectPatterns(tx, { id }))[0];
      });
    } catch (error) {
      if (pgCode(error) === "23505") {
        throw new ApiError(
          409,
          "SHIFT_PATTERN_NAME_TAKEN",
          "An active shift pattern with this name exists.",
        );
      }
      throw mapDbError(error);
    }
  }

  private async assertActiveTemplates(tx: Db, ids: string[]): Promise<void> {
    const { rows } = await tx.query<{ id: string; active: boolean }>(
      "SELECT id, active FROM shift_template WHERE id = ANY($1::uuid[])",
      [ids],
    );
    if (rows.length !== ids.length) {
      throw new ApiError(400, "SHIFT_TEMPLATE_NOT_FOUND", "A shift template does not exist.");
    }
    if (rows.some((r) => !r.active)) {
      throw new ApiError(400, "SHIFT_TEMPLATE_INACTIVE", "A shift template is retired.");
    }
  }

  // ------------------------------------------------------------------ assignments (PRD 23.4)

  async listAssignments(
    auth: AuthContext,
    filter: { employeeId?: string; from?: string; to?: string; limit: number; offset: number },
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const condition = this.scopes.employeeCondition(scope, "e", params);
      params.push(filter.employeeId ?? null, filter.from ?? null, filter.to ?? null);
      const n = params.length;
      params.push(filter.limit, filter.offset);
      const { rows } = await tx.query(
        `SELECT a.id, a.employee_id AS "employeeId", e.full_name AS "employeeName", e.employee_no AS "employeeNo",
                a.pattern_id AS "patternId", p.name AS "patternName", a.template_id AS "templateId", t.name AS "templateName",
                a.cycle_start_date::text AS "cycleStartDate", a.from_date::text AS "fromDate", a.to_date::text AS "toDate"
           FROM shift_assignment a
           JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
           LEFT JOIN shift_pattern p ON p.tenant_id = a.tenant_id AND p.id = a.pattern_id
           LEFT JOIN shift_template t ON t.tenant_id = a.tenant_id AND t.id = a.template_id
          WHERE ${condition}
            AND ($${n - 2}::uuid IS NULL OR a.employee_id = $${n - 2})
            AND ($${n - 1}::date IS NULL OR a.to_date IS NULL OR a.to_date >= $${n - 1})
            AND ($${n}::date IS NULL OR a.from_date <= $${n})
          ORDER BY e.employee_no, a.from_date
          LIMIT $${n + 1} OFFSET $${n + 2}`,
        params,
      );
      return rows;
    });
  }

  /**
   * Gives one or more employees (all or nothing) a pattern (with a cycle start date, per employee if needed so a
   * team can be staggered) or one fixed template, from `fromDate`. Only employees on a shift schedule qualify and
   * an employee has one assignment at a time.
   */
  async assign(auth: AuthContext, input: AssignmentInput, meta: RequestMeta) {
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        const scope = await this.scopes.forUser(tx, auth);
        if (input.patternId) {
          const p = await tx.query<{ active: boolean }>(
            "SELECT active FROM shift_pattern WHERE id = $1",
            [input.patternId],
          );
          if (!p.rows[0])
            throw new ApiError(400, "SHIFT_PATTERN_NOT_FOUND", "The pattern does not exist.");
          if (!p.rows[0].active)
            throw new ApiError(400, "SHIFT_PATTERN_INACTIVE", "The pattern is retired.");
        } else if (input.templateId) {
          await this.assertActiveTemplates(tx, [input.templateId]);
        }
        const created: string[] = [];
        for (const item of input.items) {
          const params: unknown[] = [item.employeeId];
          const condition = this.scopes.employeeCondition(scope, "e", params);
          const emp = await tx.query<{ status: string }>(
            `SELECT e.status FROM employee e WHERE e.id = $1 AND ${condition}`,
            params,
          );
          if (!emp.rows[0]) throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
          if (emp.rows[0].status !== "ACTIVE") {
            throw new ApiError(
              409,
              "EMPLOYEE_NOT_ACTIVE",
              "Only active employees can get a shift.",
            );
          }
          const cycle =
            item.cycleStartDate ??
            input.cycleStartDate ??
            (input.patternId ? input.fromDate : null);
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO shift_assignment
               (tenant_id, employee_id, pattern_id, template_id, cycle_start_date, from_date, to_date, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              auth.tenantId,
              item.employeeId,
              input.patternId ?? null,
              input.templateId ?? null,
              input.patternId ? cycle : null,
              input.fromDate,
              input.toDate ?? null,
              auth.userId,
            ],
          );
          created.push(rows[0]!.id);
        }
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "shift_assignment.created",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "shift_assignment",
          entityId: created[0],
          after: { ...input, assignmentIds: created },
          ...meta,
        });
        return { created: created.length, assignmentIds: created };
      });
    } catch (error) {
      throw this.mapAssignmentError(error);
    }
  }

  /** Ends an assignment on `toDate` (inclusive). Past days are kept; an assignment that has not started is removed instead. */
  async endAssignment(auth: AuthContext, id: string, toDate: string, meta: RequestMeta) {
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        const current = await this.visibleAssignment(tx, auth, id);
        if (toDate < current.fromDate) {
          throw new ApiError(
            400,
            "INVALID_DATES",
            "The end date is before the assignment starts; delete it instead.",
          );
        }
        if (current.toDate !== null && toDate > current.toDate) {
          throw new ApiError(400, "INVALID_DATES", "An assignment can only be shortened.");
        }
        await tx.query("UPDATE shift_assignment SET to_date = $2 WHERE id = $1", [id, toDate]);
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "shift_assignment.ended",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "shift_assignment",
          entityId: id,
          before: current,
          after: { toDate },
          ...meta,
        });
        return { id, toDate };
      });
    } catch (error) {
      throw this.mapAssignmentError(error);
    }
  }

  /** Only an assignment that has not started yet can be deleted; later ones are ended (history is kept). */
  async deleteAssignment(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const current = await this.visibleAssignment(tx, auth, id);
      const today = await tenantToday(tx, this.clock, auth.tenantId);
      if (current.fromDate <= today) {
        throw new ApiError(
          409,
          "ASSIGNMENT_STARTED",
          "The assignment has started; end it instead of deleting it.",
        );
      }
      await tx.query("DELETE FROM shift_assignment WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "shift_assignment.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "shift_assignment",
        entityId: id,
        before: current,
        ...meta,
      });
    });
  }

  private async visibleAssignment(tx: Db, auth: AuthContext, id: string) {
    const scope = await this.scopes.forUser(tx, auth);
    const params: unknown[] = [id];
    const condition = this.scopes.employeeCondition(scope, "e", params);
    const { rows } = await tx.query<{
      fromDate: string;
      toDate: string | null;
      employeeId: string;
    }>(
      `SELECT a.employee_id AS "employeeId", a.from_date::text AS "fromDate", a.to_date::text AS "toDate"
         FROM shift_assignment a JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
        WHERE a.id = $1 AND ${condition}`,
      params,
    );
    if (!rows[0])
      throw new ApiError(404, "SHIFT_ASSIGNMENT_NOT_FOUND", "Shift assignment not found.");
    return rows[0];
  }

  private mapAssignmentError(error: unknown): unknown {
    if (pgCode(error) === "23P01") {
      return new ApiError(
        409,
        "SHIFT_ASSIGNMENT_OVERLAP",
        "An employee can have only one shift assignment at a time; end the current one first.",
      );
    }
    return mapDbError(error);
  }

  // ------------------------------------------------------------------ overrides (PRD 23.1)

  async listOverrides(
    auth: AuthContext,
    filter: { employeeId?: string; from?: string; to?: string; limit: number; offset: number },
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const condition = this.scopes.employeeCondition(scope, "e", params);
      params.push(filter.employeeId ?? null, filter.from ?? null, filter.to ?? null);
      const n = params.length;
      params.push(filter.limit, filter.offset);
      const { rows } = await tx.query(
        `SELECT o.id, o.employee_id AS "employeeId", e.full_name AS "employeeName", o.work_date::text AS "workDate",
                o.kind, o.template_id AS "templateId", t.name AS "templateName", o.reason
           FROM shift_override o
           JOIN employee e ON e.tenant_id = o.tenant_id AND e.id = o.employee_id
           LEFT JOIN shift_template t ON t.tenant_id = o.tenant_id AND t.id = o.template_id
          WHERE ${condition}
            AND ($${n - 2}::uuid IS NULL OR o.employee_id = $${n - 2})
            AND ($${n - 1}::date IS NULL OR o.work_date >= $${n - 1}) AND ($${n}::date IS NULL OR o.work_date <= $${n})
          ORDER BY o.work_date, e.employee_no
          LIMIT $${n + 1} OFFSET $${n + 2}`,
        params,
      );
      return rows;
    });
  }

  async createOverride(
    auth: AuthContext,
    input: {
      employeeId: string;
      workDate: string;
      kind: "ADD" | "REMOVE" | "SWAP";
      templateId?: string;
      reason?: string;
    },
    meta: RequestMeta,
  ) {
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        const scope = await this.scopes.forUser(tx, auth);
        const params: unknown[] = [input.employeeId];
        const condition = this.scopes.employeeCondition(scope, "e", params);
        const emp = await tx.query<{ schedule_mode: string }>(
          `SELECT e.schedule_mode FROM employee e WHERE e.id = $1 AND ${condition}`,
          params,
        );
        if (!emp.rows[0]) throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
        if (emp.rows[0].schedule_mode !== "SHIFT") {
          throw new ApiError(
            400,
            "SHIFT_MODE_REQUIRED",
            "The employee is not on a shift schedule.",
          );
        }
        if (input.templateId) await this.assertActiveTemplates(tx, [input.templateId]);
        let id: string;
        try {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO shift_override (tenant_id, employee_id, work_date, kind, template_id, reason, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              auth.tenantId,
              input.employeeId,
              input.workDate,
              input.kind,
              input.kind === "REMOVE" ? null : input.templateId,
              input.reason ?? null,
              auth.userId,
            ],
          );
          id = rows[0]!.id;
        } catch (error) {
          if (pgCode(error) === "23505") {
            throw new ApiError(
              409,
              "OVERRIDE_EXISTS",
              "That employee already has an override on this date; delete it first.",
            );
          }
          throw error;
        }
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "shift_override.created",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "shift_override",
          entityId: id,
          after: input,
          ...meta,
        });
        return { id, ...input };
      });
    } catch (error) {
      throw mapDbError(error);
    }
  }

  async deleteOverride(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [id];
      const condition = this.scopes.employeeCondition(scope, "e", params);
      const found = await tx.query(
        `SELECT o.employee_id AS "employeeId", o.work_date::text AS "workDate", o.kind
           FROM shift_override o JOIN employee e ON e.tenant_id = o.tenant_id AND e.id = o.employee_id
          WHERE o.id = $1 AND ${condition}`,
        params,
      );
      if (!found.rows[0]) throw new ApiError(404, "OVERRIDE_NOT_FOUND", "Override not found.");
      await tx.query("DELETE FROM shift_override WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "shift_override.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "shift_override",
        entityId: id,
        before: found.rows[0],
        ...meta,
      });
    });
  }
}
