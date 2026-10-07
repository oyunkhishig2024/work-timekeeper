import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { updateColumns } from "../common/sql";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";

const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === "23505";

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Managers see the structure but not employee counts (those would reveal other locations' headcount). */
  async list(auth: AuthContext, filter: { active?: boolean }) {
    return this.db.withTenant(auth.tenantId, (tx) => this.select(tx, auth, filter));
  }

  async get(auth: AuthContext, id: string) {
    const found = await this.db.withTenant(
      auth.tenantId,
      async (tx) => (await this.select(tx, auth, { id }))[0],
    );
    if (!found) throw new ApiError(404, "DEPARTMENT_NOT_FOUND", "Department not found.");
    return found;
  }

  /** Reads inside the caller's transaction so a write is visible in its own response. */
  private async select(tx: Db, auth: AuthContext, filter: { active?: boolean; id?: string }) {
    const withCounts = auth.role !== "MANAGER";
    const { rows } = await tx.query(
      `SELECT d.id, d.name, d.active, d.created_at AS "createdAt",
              ${withCounts ? `(SELECT count(*)::int FROM employee e WHERE e.tenant_id = d.tenant_id AND e.department_id = d.id AND e.status = 'ACTIVE')` : "NULL::int"} AS "activeEmployees"
         FROM department d
        WHERE ($1::boolean IS NULL OR d.active = $1) AND ($2::uuid IS NULL OR d.id = $2)
        ORDER BY d.name`,
      [filter.active ?? null, filter.id ?? null],
    );
    return rows;
  }

  async create(auth: AuthContext, input: { name: string }, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          "INSERT INTO department (tenant_id, name) VALUES ($1, $2) RETURNING id",
          [auth.tenantId, input.name],
        );
        id = rows[0]!.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(
            409,
            "DEPARTMENT_NAME_TAKEN",
            "A department with this name already exists.",
          );
        }
        throw error;
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "department.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "department",
        entityId: id,
        after: { name: input.name },
        ...meta,
      });
      return { id, name: input.name, active: true };
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    input: { name?: string; active?: boolean },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const exists = await tx.query("SELECT 1 FROM department WHERE id = $1", [id]);
      if (exists.rowCount === 0)
        throw new ApiError(404, "DEPARTMENT_NOT_FOUND", "Department not found.");
      if (input.active === false) {
        const used = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM employee WHERE department_id = $1 AND status = 'ACTIVE'",
          [id],
        );
        if (used.rows[0]!.n > 0) {
          throw new ApiError(
            409,
            "DEPARTMENT_IN_USE",
            "The department still has active employees. Move them first.",
            {
              activeEmployees: used.rows[0]!.n,
            },
          );
        }
      }
      let result;
      try {
        result = await updateColumns(tx, "department", id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(
            409,
            "DEPARTMENT_NAME_TAKEN",
            "A department with this name already exists.",
          );
        }
        throw error;
      }
      if (result.changed) {
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "department.updated",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "department",
          entityId: id,
          before: result.before,
          after: input,
          ...meta,
        });
      }
      const { rows } = await tx.query("SELECT id, name, active FROM department WHERE id = $1", [
        id,
      ]);
      return rows[0];
    });
  }

  /** Only a department nobody ever belonged to can be deleted; otherwise deactivate it (history is kept). */
  async remove(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ name: string }>(
        "SELECT name FROM department WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!found.rows[0]) throw new ApiError(404, "DEPARTMENT_NOT_FOUND", "Department not found.");
      const used = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM employee WHERE department_id = $1",
        [id],
      );
      if (used.rows[0]!.n > 0) {
        throw new ApiError(
          409,
          "DEPARTMENT_IN_USE",
          "Employees belong or belonged to this department; deactivate it instead.",
          {
            employees: used.rows[0]!.n,
          },
        );
      }
      await tx.query("DELETE FROM user_scope WHERE department_id = $1", [id]);
      await tx.query("DELETE FROM department WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "department.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "department",
        entityId: id,
        before: { name: found.rows[0].name },
        ...meta,
      });
    });
  }
}
