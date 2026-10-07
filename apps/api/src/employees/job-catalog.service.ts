import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { updateColumns } from "../common/sql";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { JOB_KINDS, type JobKind } from "./job-kinds";

const pgCode = (error: unknown) => (error as { code?: string })?.code;
const pgConstraint = (error: unknown) => (error as { constraint?: string })?.constraint ?? "";

export interface CatalogInput {
  name?: string;
  sortOrder?: number;
  active?: boolean;
}

/**
 * The tenant's lists of ranks (цол, ordered by seniority) and job positions (албан тушаал).
 * Entries are never deleted (history refers to them): deactivate instead; an inactive entry cannot be newly assigned.
 */
@Injectable()
export class JobCatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, kind: JobKind, filter: { active?: boolean }) {
    return this.db.withTenant(auth.tenantId, (tx) => this.select(tx, auth, kind, filter));
  }

  async get(auth: AuthContext, kind: JobKind, id: string) {
    const found = await this.db.withTenant(
      auth.tenantId,
      async (tx) => (await this.select(tx, auth, kind, { id }))[0],
    );
    if (!found) throw this.notFound(kind);
    return found;
  }

  /** Managers see the lists but not holder counts (they could reveal other locations' headcount). */
  private async select(
    tx: Db,
    auth: AuthContext,
    kind: JobKind,
    filter: { active?: boolean; id?: string },
  ) {
    const k = JOB_KINDS[kind];
    const withCounts = auth.role !== "MANAGER";
    const order = kind === "rank" ? "c.sort_order, c.name" : "c.name";
    const { rows } = await tx.query(
      `SELECT c.id, c.name, ${kind === "rank" ? 'c.sort_order AS "sortOrder",' : ""} c.active,
              ${
                withCounts
                  ? `(SELECT count(*)::int FROM ${k.assignment} a
                        JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
                       WHERE a.tenant_id = c.tenant_id AND a.${k.catalogColumn} = c.id
                         AND a.valid_to IS NULL AND e.status = 'ACTIVE')`
                  : "NULL::int"
              } AS "activeHolders"
         FROM ${k.catalog} c
        WHERE ($1::boolean IS NULL OR c.active = $1) AND ($2::uuid IS NULL OR c.id = $2)
        ORDER BY ${order}`,
      [filter.active ?? null, filter.id ?? null],
    );
    return rows;
  }

  async create(
    auth: AuthContext,
    kind: JobKind,
    input: Required<Pick<CatalogInput, "name">> & CatalogInput,
    meta: RequestMeta,
  ) {
    const k = JOB_KINDS[kind];
    return this.db.withTenant(auth.tenantId, async (tx) => {
      let id: string;
      try {
        if (kind === "rank") {
          const sortOrder = input.sortOrder ?? (await this.nextOrder(tx));
          const { rows } = await tx.query<{ id: string }>(
            "INSERT INTO job_rank (tenant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id",
            [auth.tenantId, input.name, sortOrder],
          );
          id = rows[0]!.id;
        } else {
          const { rows } = await tx.query<{ id: string }>(
            "INSERT INTO job_position (tenant_id, name) VALUES ($1, $2) RETURNING id",
            [auth.tenantId, input.name],
          );
          id = rows[0]!.id;
        }
      } catch (error) {
        throw this.mapWriteError(kind, error);
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: `${k.label}.created`,
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: k.label,
        entityId: id,
        after: input,
        ...meta,
      });
      return (await this.select(tx, auth, kind, { id }))[0];
    });
  }

  async update(
    auth: AuthContext,
    kind: JobKind,
    id: string,
    input: CatalogInput,
    meta: RequestMeta,
  ) {
    const k = JOB_KINDS[kind];
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const exists = await tx.query(`SELECT 1 FROM ${k.catalog} WHERE id = $1`, [id]);
      if (exists.rowCount === 0) throw this.notFound(kind);
      let result;
      try {
        result = await updateColumns(tx, k.catalog, id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(kind === "rank" && input.sortOrder !== undefined
            ? { sort_order: input.sortOrder }
            : {}),
        });
      } catch (error) {
        throw this.mapWriteError(kind, error);
      }
      if (result.changed) {
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: `${k.label}.updated`,
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: k.label,
          entityId: id,
          before: result.before,
          after: input,
          ...meta,
        });
      }
      return (await this.select(tx, auth, kind, { id }))[0];
    });
  }

  private async nextOrder(tx: Db): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      "SELECT COALESCE(max(sort_order), 0)::int + 1 AS n FROM job_rank",
    );
    return rows[0]!.n;
  }

  private notFound(kind: JobKind): ApiError {
    const label = JOB_KINDS[kind].label;
    return new ApiError(404, `${JOB_KINDS[kind].code}_NOT_FOUND`, `The ${label} does not exist.`);
  }

  private mapWriteError(kind: JobKind, error: unknown): unknown {
    if (pgCode(error) !== "23505") return error;
    const code = JOB_KINDS[kind].code;
    if (pgConstraint(error).includes("sort_order")) {
      return new ApiError(
        409,
        `${code}_ORDER_TAKEN`,
        "Another rank already has this order number.",
      );
    }
    return new ApiError(
      409,
      `${code}_NAME_TAKEN`,
      `A ${JOB_KINDS[kind].label} with this name already exists.`,
    );
  }
}
