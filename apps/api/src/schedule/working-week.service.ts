import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { mapDbError } from "../common/db-errors";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { makeRoomFrom } from "./version-timeline";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";

export interface WeekDayInput {
  weekday: number;
  working: boolean;
  start?: string | null;
  end?: string | null;
}

export interface ExceptionInput {
  date: string;
  working: boolean;
  start?: string | null;
  end?: string | null;
  locationId?: string | null;
  note?: string | null;
}

interface VersionRow {
  id: string;
  validFrom: string;
  validTo: string | null;
}

/**
 * Working week (PRD 14.1): one effective-dated weekly table for the tenant, optionally overridden per
 * location, plus single-date working-day exceptions. A new table applies from its effective date forward;
 * the past is never rewritten (PRD 22.1), so the effective date cannot be in the past.
 */
@Injectable()
export class WorkingWeekService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ reading

  /** The table in force on `asOf` (default today) for the location, falling back to the tenant default. */
  async get(auth: AuthContext, filter: { locationId?: string; asOf?: string }) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const date = filter.asOf ?? (await tenantToday(tx, this.clock, auth.tenantId));
      if (filter.locationId) {
        await this.assertLocation(tx, filter.locationId);
        const own = await this.inForce(tx, filter.locationId, date);
        if (own) return { ...own, inherited: false };
      }
      const tenantWide = await this.inForce(tx, null, date);
      if (!tenantWide) {
        throw new ApiError(
          404,
          "WORKING_WEEK_NOT_CONFIGURED",
          "No working week is in force on that date.",
        );
      }
      return { ...tenantWide, inherited: filter.locationId !== undefined };
    });
  }

  /** All versions of one scope (tenant default or one location), newest first. */
  async versions(auth: AuthContext, locationId: string | null) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      if (locationId) await this.assertLocation(tx, locationId);
      const { rows } = await tx.query<VersionRow>(
        `SELECT id, valid_from::text AS "validFrom", valid_to::text AS "validTo"
           FROM working_week_version
          WHERE location_id IS NOT DISTINCT FROM $1 ORDER BY valid_from DESC`,
        [locationId],
      );
      const out = [];
      for (const v of rows) out.push({ ...v, locationId, days: await this.days(tx, v.id) });
      return out;
    });
  }

  // ------------------------------------------------------------------ changing the table

  /** New weekly table from `effectiveFrom` (default today) for the tenant or one location. */
  async put(
    auth: AuthContext,
    input: { locationId?: string | null; effectiveFrom?: string; days: WeekDayInput[] },
    meta: RequestMeta,
  ) {
    const locationId = input.locationId ?? null;
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        if (locationId) await this.assertLocation(tx, locationId);
        const today = await tenantToday(tx, this.clock, auth.tenantId);
        const effective = input.effectiveFrom ?? today;
        if (effective < today) {
          throw new ApiError(
            400,
            "EFFECTIVE_DATE_IN_PAST",
            "A new working week applies from today or later; past attendance is not rewritten.",
          );
        }
        await makeRoomFrom(tx, "working_week_version", locationId, effective, today);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO working_week_version (tenant_id, location_id, valid_from, created_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [auth.tenantId, locationId, effective, auth.userId],
        );
        const id = rows[0]!.id;
        for (const d of input.days) {
          await tx.query(
            `INSERT INTO working_week_day (tenant_id, working_week_id, weekday, working, start_time, end_time)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              auth.tenantId,
              id,
              d.weekday,
              d.working,
              d.working ? d.start : null,
              d.working ? d.end : null,
            ],
          );
        }
        if (locationId) {
          await tx.query("UPDATE location SET working_week_mode = 'OVERRIDE' WHERE id = $1", [
            locationId,
          ]);
        }
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "working_week.changed",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "working_week",
          entityId: id,
          after: { locationId, effectiveFrom: effective, days: input.days },
          ...meta,
        });
        return {
          id,
          locationId,
          validFrom: effective,
          validTo: null,
          days: await this.days(tx, id),
        };
      });
    } catch (error) {
      throw mapDbError(error);
    }
  }

  /** A location goes back to the tenant default from `effectiveFrom` (default today). */
  async inherit(
    auth: AuthContext,
    input: { locationId: string; effectiveFrom?: string },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      await this.assertLocation(tx, input.locationId);
      const today = await tenantToday(tx, this.clock, auth.tenantId);
      const effective = input.effectiveFrom ?? today;
      if (effective < today) {
        throw new ApiError(400, "EFFECTIVE_DATE_IN_PAST", "Use today or a later date.");
      }
      const mode = await tx.query<{ working_week_mode: string }>(
        "SELECT working_week_mode FROM location WHERE id = $1 FOR UPDATE",
        [input.locationId],
      );
      if (mode.rows[0]?.working_week_mode !== "OVERRIDE") {
        throw new ApiError(
          409,
          "LOCATION_NOT_OVERRIDDEN",
          "The location already uses the default.",
        );
      }
      await makeRoomFrom(tx, "working_week_version", input.locationId, effective, today);
      await tx.query("UPDATE location SET working_week_mode = 'INHERIT' WHERE id = $1", [
        input.locationId,
      ]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "working_week.override_removed",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "location",
        entityId: input.locationId,
        after: { effectiveFrom: effective },
        ...meta,
      });
      return { locationId: input.locationId, inheritsFrom: effective };
    });
  }

  // ------------------------------------------------------------------ working-day exceptions (PRD 14.1)

  async listExceptions(
    auth: AuthContext,
    filter: { from?: string; to?: string; locationId?: string },
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, location_id AS "locationId", exception_date::text AS date, working,
                to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end", note
           FROM working_day_exception
          WHERE ($1::date IS NULL OR exception_date >= $1) AND ($2::date IS NULL OR exception_date <= $2)
            AND ($3::uuid IS NULL OR location_id = $3)
          ORDER BY exception_date, location_id NULLS FIRST`,
        [filter.from ?? null, filter.to ?? null, filter.locationId ?? null],
      );
      return rows;
    });
  }

  async createException(auth: AuthContext, input: ExceptionInput, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      if (input.locationId) await this.assertLocation(tx, input.locationId);
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO working_day_exception
             (tenant_id, location_id, exception_date, working, start_time, end_time, note, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            auth.tenantId,
            input.locationId ?? null,
            input.date,
            input.working,
            input.working ? (input.start ?? null) : null,
            input.working ? (input.end ?? null) : null,
            input.note ?? null,
            auth.userId,
          ],
        );
        id = rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ApiError(
            409,
            "EXCEPTION_EXISTS",
            "That date already has an exception for this scope; delete it first.",
          );
        }
        throw error;
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "working_day_exception.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "working_day_exception",
        entityId: id,
        after: input,
        ...meta,
      });
      return { id, ...input, locationId: input.locationId ?? null };
    });
  }

  async deleteException(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `DELETE FROM working_day_exception WHERE id = $1
         RETURNING location_id AS "locationId", exception_date::text AS date, working`,
        [id],
      );
      if (!rows[0]) throw new ApiError(404, "EXCEPTION_NOT_FOUND", "Exception not found.");
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "working_day_exception.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "working_day_exception",
        entityId: id,
        before: rows[0],
        ...meta,
      });
    });
  }

  // ------------------------------------------------------------------ helpers

  private async assertLocation(tx: Db, locationId: string): Promise<void> {
    const found = await tx.query("SELECT 1 FROM location WHERE id = $1", [locationId]);
    if (found.rowCount === 0) throw new ApiError(404, "LOCATION_NOT_FOUND", "Location not found.");
  }

  private async inForce(tx: Db, locationId: string | null, date: string) {
    const { rows } = await tx.query<VersionRow>(
      `SELECT id, valid_from::text AS "validFrom", valid_to::text AS "validTo"
         FROM working_week_version
        WHERE location_id IS NOT DISTINCT FROM $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
      [locationId, date],
    );
    const version = rows[0];
    if (!version) return null;
    return { ...version, locationId, days: await this.days(tx, version.id) };
  }

  private async days(tx: Db, versionId: string) {
    const { rows } = await tx.query(
      `SELECT weekday, working, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
         FROM working_week_day WHERE working_week_id = $1 ORDER BY weekday`,
      [versionId],
    );
    return rows;
  }
}
