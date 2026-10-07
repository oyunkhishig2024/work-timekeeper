import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { updateColumns } from "../common/sql";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";

export interface LocationInput {
  name: string;
  address?: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  workingWeekMode?: "INHERIT" | "OVERRIDE";
}

const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === "23505";
const nameTaken = () =>
  new ApiError(409, "LOCATION_NAME_TAKEN", "A location with this name already exists.");

const COLUMNS = {
  name: "name",
  address: "address",
  lat: "lat",
  lng: "lng",
  radiusM: "radius_m",
  active: "active",
  workingWeekMode: "working_week_mode",
} as const;

@Injectable()
export class LocationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, filter: { active?: boolean }) {
    return this.db.withTenant(auth.tenantId, (tx) => this.select(tx, auth, filter));
  }

  async get(auth: AuthContext, id: string) {
    const found = await this.db.withTenant(
      auth.tenantId,
      async (tx) => (await this.select(tx, auth, { id }))[0],
    );
    if (!found) throw new ApiError(404, "LOCATION_NOT_FOUND", "Location not found.");
    return found;
  }

  /** Reads inside the caller's transaction so a write is visible in its own response. */
  private async select(tx: Db, auth: AuthContext, filter: { active?: boolean; id?: string }) {
    const withCounts = auth.role !== "MANAGER";
    const { rows } = await tx.query(
      `SELECT l.id, l.name, l.address, l.lat, l.lng, l.radius_m AS "radiusM", l.active,
              l.working_week_mode AS "workingWeekMode", l.created_at AS "createdAt",
              ${withCounts ? `(SELECT count(*)::int FROM employee e WHERE e.tenant_id = l.tenant_id AND e.primary_location_id = l.id AND e.status = 'ACTIVE')` : "NULL::int"} AS "activeEmployees"
         FROM location l
        WHERE ($1::boolean IS NULL OR l.active = $1) AND ($2::uuid IS NULL OR l.id = $2)
        ORDER BY l.name`,
      [filter.active ?? null, filter.id ?? null],
    );
    return rows;
  }

  async create(auth: AuthContext, input: LocationInput, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO location (tenant_id, name, address, lat, lng, radius_m, working_week_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            auth.tenantId,
            input.name,
            input.address ?? null,
            input.lat,
            input.lng,
            input.radiusM,
            input.workingWeekMode ?? "INHERIT",
          ],
        );
        id = rows[0]!.id;
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "location.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "location",
        entityId: id,
        after: input,
        ...meta,
      });
      return {
        id,
        ...input,
        address: input.address ?? null,
        active: true,
        workingWeekMode: input.workingWeekMode ?? "INHERIT",
      };
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    input: Partial<LocationInput> & { active?: boolean },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const exists = await tx.query("SELECT 1 FROM location WHERE id = $1", [id]);
      if (exists.rowCount === 0)
        throw new ApiError(404, "LOCATION_NOT_FOUND", "Location not found.");
      if (input.active === false) {
        const used = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM employee WHERE primary_location_id = $1 AND status = 'ACTIVE'",
          [id],
        );
        if (used.rows[0]!.n > 0) {
          throw new ApiError(
            409,
            "LOCATION_IN_USE",
            "Active employees still have this location as their primary location. Reassign them first.",
            {
              activeEmployees: used.rows[0]!.n,
            },
          );
        }
      }
      const columns: Record<string, unknown> = {};
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value !== undefined) columns[column] = value;
      }
      let result;
      try {
        result = await updateColumns(tx, "location", id, columns);
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
      if (result.changed) {
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "location.updated",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "location",
          entityId: id,
          before: result.before,
          after: input,
          ...meta,
        });
      }
      return (await this.select(tx, auth, { id }))[0];
    });
  }

  async remove(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ name: string }>(
        "SELECT name FROM location WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!found.rows[0]) throw new ApiError(404, "LOCATION_NOT_FOUND", "Location not found.");
      const used = await tx.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM employee WHERE primary_location_id = $1)
              + (SELECT count(*) FROM temp_location_assignment WHERE location_id = $1) AS n`,
        [id],
      );
      if (Number(used.rows[0]!.n) > 0) {
        throw new ApiError(
          409,
          "LOCATION_IN_USE",
          "The location is or was in use; deactivate it instead.",
        );
      }
      await tx.query("DELETE FROM user_scope WHERE location_id = $1", [id]);
      await tx.query("DELETE FROM location WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "location.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "location",
        entityId: id,
        before: { name: found.rows[0].name },
        ...meta,
      });
    });
  }
}
