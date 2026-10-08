import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { mapDbError } from "../common/db-errors";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { makeRoomFrom } from "./version-timeline";

export interface RulesInput {
  graceMinutes: number;
  minStayMinutes: number;
}

/** The PRD defaults (6.2, 6.4), used until the Org Admin saves the first version. */
export const DEFAULT_RULES: RulesInput = {
  graceMinutes: 15,
  minStayMinutes: 3,
};

const COLUMNS = `id, valid_from::text AS "validFrom", valid_to::text AS "validTo",
  grace_minutes AS "graceMinutes", min_stay_minutes AS "minStayMinutes"`;

/**
 * Attendance rule versions (PRD 6.2–6.4, 13, 22.1): grace (late after start + grace), no-show cut-off (Ирээгүй after
 * start + cut-off with no arrival and no reason), minimum stay and the early-entry window, for the whole tenant or
 * per location, effective-dated. A change applies from its date forward and never recalculates the past.
 */
@Injectable()
export class AttendanceRulesService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** The rules in force on `asOf` (default today) for the location, falling back to the tenant default and then to the PRD defaults. */
  async get(auth: AuthContext, filter: { locationId?: string; asOf?: string }) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const date = filter.asOf ?? (await tenantToday(tx, this.clock, auth.tenantId));
      if (filter.locationId) {
        await this.assertLocation(tx, filter.locationId);
        const own = await this.inForce(tx, filter.locationId, date);
        if (own) return { ...own, locationId: filter.locationId, source: "LOCATION" as const };
      }
      const tenantWide = await this.inForce(tx, null, date);
      if (tenantWide) return { ...tenantWide, locationId: null, source: "TENANT" as const };
      return {
        id: null,
        validFrom: null,
        validTo: null,
        locationId: null,
        ...DEFAULT_RULES,
        source: "DEFAULT" as const,
      };
    });
  }

  async versions(auth: AuthContext, locationId: string | null) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      if (locationId) await this.assertLocation(tx, locationId);
      const { rows } = await tx.query(
        `SELECT ${COLUMNS} FROM attendance_rule_version
          WHERE location_id IS NOT DISTINCT FROM $1 ORDER BY valid_from DESC`,
        [locationId],
      );
      return rows.map((r) => ({ ...r, locationId }));
    });
  }

  /** New rules from `effectiveFrom` (default today) for the tenant or one location. The past is never rewritten. */
  async put(
    auth: AuthContext,
    input: RulesInput & { locationId?: string | null; effectiveFrom?: string },
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
            "New rules apply from today or later; past attendance is not recalculated.",
          );
        }
        const before = await this.inForce(tx, locationId, today);
        await makeRoomFrom(tx, "attendance_rule_version", locationId, effective, today);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO attendance_rule_version
             (tenant_id, location_id, valid_from, grace_minutes, min_stay_minutes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            auth.tenantId,
            locationId,
            effective,
            input.graceMinutes,
            input.minStayMinutes,
            auth.userId,
          ],
        );
        const id = rows[0]!.id;
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "attendance_rules.changed",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "attendance_rule_version",
          entityId: id,
          before: before ?? null,
          after: { locationId, effectiveFrom: effective, ...pick(input) },
          ...meta,
        });
        return { id, locationId, validFrom: effective, validTo: null, ...pick(input) };
      });
    } catch (error) {
      throw mapDbError(error);
    }
  }

  /** A location stops having its own rules from `effectiveFrom` (default today) and uses the tenant default. */
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
      const any = await tx.query(
        "SELECT 1 FROM attendance_rule_version WHERE location_id = $1 AND (valid_to IS NULL OR valid_to > $2)",
        [input.locationId, today],
      );
      if (any.rowCount === 0) {
        throw new ApiError(
          409,
          "LOCATION_NOT_OVERRIDDEN",
          "The location already uses the tenant rules.",
        );
      }
      await makeRoomFrom(tx, "attendance_rule_version", input.locationId, effective, today);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "attendance_rules.override_removed",
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

  private async assertLocation(tx: Db, locationId: string): Promise<void> {
    const found = await tx.query("SELECT 1 FROM location WHERE id = $1", [locationId]);
    if (found.rowCount === 0) throw new ApiError(404, "LOCATION_NOT_FOUND", "Location not found.");
  }

  private async inForce(tx: Db, locationId: string | null, date: string) {
    const { rows } = await tx.query(
      `SELECT ${COLUMNS} FROM attendance_rule_version
        WHERE location_id IS NOT DISTINCT FROM $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
      [locationId, date],
    );
    return rows[0] as
      (RulesInput & { id: string; validFrom: string; validTo: string | null }) | undefined;
  }
}

const pick = (r: RulesInput): RulesInput => ({
  graceMinutes: r.graceMinutes,
  minStayMinutes: r.minStayMinutes,
});
