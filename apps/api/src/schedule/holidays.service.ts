import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { mapDbError } from "../common/db-errors";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";

export type HolidayKind = "PUBLIC_HOLIDAY" | "COMPANY_DAY_OFF" | "TRANSFERRED_DAY_OFF";

export interface HolidayInput {
  name: string;
  fromDate: string;
  toDate: string;
  kind: HolidayKind;
  repeatsYearly: boolean;
  appliesToAll: boolean;
  locationIds: string[];
}

const pgCode = (error: unknown) => (error as { code?: string })?.code;

/** The same calendar date in another year (29 February clamps to 28 February). */
export function shiftYear(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const year = y + years;
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * Holiday calendar (PRD 14.2). Holiday dates are not shipped as authoritative: the Org Admin enters them.
 * Adding, changing or removing a holiday that touches today or a past date changes attendance that already
 * exists, so it needs an explicit `confirmRecompute: true` (the recompute itself comes with the attendance engine).
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(
    auth: AuthContext,
    filter: { from?: string; to?: string; year?: number; locationId?: string },
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const from = filter.from ?? (filter.year ? `${filter.year}-01-01` : null);
      const to = filter.to ?? (filter.year ? `${filter.year}-12-31` : null);
      return this.select(tx, { from, to, locationId: filter.locationId ?? null });
    });
  }

  async get(auth: AuthContext, id: string) {
    const found = await this.db.withTenant(
      auth.tenantId,
      async (tx) => (await this.select(tx, { id }))[0],
    );
    if (!found) throw new ApiError(404, "HOLIDAY_NOT_FOUND", "Holiday not found.");
    return found;
  }

  private async select(
    tx: Db,
    f: { id?: string; from?: string | null; to?: string | null; locationId?: string | null },
  ) {
    const { rows } = await tx.query(
      `SELECT h.id, h.name, h.from_date::text AS "fromDate", h.to_date::text AS "toDate", h.kind,
              h.repeats_yearly AS "repeatsYearly", h.applies_to_all AS "appliesToAll",
              COALESCE((SELECT json_agg(hl.location_id ORDER BY hl.location_id)
                          FROM holiday_location hl WHERE hl.holiday_id = h.id), '[]'::json) AS "locationIds"
         FROM holiday h
        WHERE ($1::uuid IS NULL OR h.id = $1)
          AND ($2::date IS NULL OR h.to_date >= $2) AND ($3::date IS NULL OR h.from_date <= $3)
          AND ($4::uuid IS NULL OR h.applies_to_all
               OR EXISTS (SELECT 1 FROM holiday_location hl WHERE hl.holiday_id = h.id AND hl.location_id = $4))
        ORDER BY h.from_date, h.name`,
      [f.id ?? null, f.from ?? null, f.to ?? null, f.locationId ?? null],
    );
    return rows;
  }

  async create(
    auth: AuthContext,
    input: HolidayInput & { confirmRecompute?: boolean },
    meta: RequestMeta,
  ) {
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        await this.assertRecompute(tx, auth, input.fromDate, input.confirmRecompute);
        const id = await this.insertHoliday(tx, auth, input);
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "holiday.created",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "holiday",
          entityId: id,
          after: input,
          ...meta,
        });
        return (await this.select(tx, { id }))[0];
      });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async update(
    auth: AuthContext,
    id: string,
    input: Partial<HolidayInput> & { confirmRecompute?: boolean },
    meta: RequestMeta,
  ) {
    try {
      return await this.db.withTenant(auth.tenantId, async (tx) => {
        const current = (await this.select(tx, { id }))[0] as
          (HolidayInput & { id: string }) | undefined;
        if (!current) throw new ApiError(404, "HOLIDAY_NOT_FOUND", "Holiday not found.");
        const next: HolidayInput = {
          name: input.name ?? current.name,
          fromDate: input.fromDate ?? current.fromDate,
          toDate: input.toDate ?? current.toDate,
          kind: input.kind ?? current.kind,
          repeatsYearly: input.repeatsYearly ?? current.repeatsYearly,
          appliesToAll: input.appliesToAll ?? current.appliesToAll,
          locationIds: input.locationIds ?? (input.appliesToAll ? [] : current.locationIds),
        };
        if (next.toDate < next.fromDate) {
          throw new ApiError(400, "INVALID_DATES", "The end date cannot be before the start date.");
        }
        // Any change touches the old dates and the new ones.
        await this.assertRecompute(tx, auth, current.fromDate, input.confirmRecompute);
        await this.assertRecompute(tx, auth, next.fromDate, input.confirmRecompute);
        await tx.query(
          `UPDATE holiday SET name = $2, from_date = $3, to_date = $4, kind = $5, repeats_yearly = $6,
                  applies_to_all = $7 WHERE id = $1`,
          [
            id,
            next.name,
            next.fromDate,
            next.toDate,
            next.kind,
            next.repeatsYearly,
            next.appliesToAll,
          ],
        );
        await tx.query("DELETE FROM holiday_location WHERE holiday_id = $1", [id]);
        await this.insertLocations(tx, auth, id, next);
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "holiday.updated",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "holiday",
          entityId: id,
          before: current,
          after: next,
          ...meta,
        });
        return (await this.select(tx, { id }))[0];
      });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async remove(
    auth: AuthContext,
    id: string,
    confirmRecompute: boolean | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      const current = (await this.select(tx, { id }))[0] as { fromDate: string } | undefined;
      if (!current) throw new ApiError(404, "HOLIDAY_NOT_FOUND", "Holiday not found.");
      await this.assertRecompute(tx, auth, current.fromDate, confirmRecompute);
      await tx.query("DELETE FROM holiday WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "holiday.deleted",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "holiday",
        entityId: id,
        before: current,
        ...meta,
      });
    });
  }

  /** "Copy from previous year": every holiday of `fromYear` is created again in `toYear`; duplicates are skipped. */
  async copyYear(
    auth: AuthContext,
    input: { fromYear: number; toYear: number; confirmRecompute?: boolean },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const source = (await this.select(tx, {
        from: `${input.fromYear}-01-01`,
        to: `${input.fromYear}-12-31`,
      })) as Array<HolidayInput & { fromDate: string }>;
      const created: string[] = [];
      let skipped = 0;
      for (const h of source.filter((x) => x.fromDate.startsWith(`${input.fromYear}-`))) {
        const years = input.toYear - input.fromYear;
        const copy: HolidayInput = {
          ...h,
          fromDate: shiftYear(h.fromDate, years),
          toDate: shiftYear(h.toDate, years),
        };
        const exists = await tx.query("SELECT 1 FROM holiday WHERE name = $1 AND from_date = $2", [
          copy.name,
          copy.fromDate,
        ]);
        if ((exists.rowCount ?? 0) > 0) {
          skipped += 1;
          continue;
        }
        await this.assertRecompute(tx, auth, copy.fromDate, input.confirmRecompute);
        created.push(await this.insertHoliday(tx, auth, copy));
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "holiday.year_copied",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "holiday",
        after: { fromYear: input.fromYear, toYear: input.toYear, created: created.length, skipped },
        ...meta,
      });
      return { created: created.length, skipped };
    });
  }

  // ------------------------------------------------------------------ helpers

  async insertHoliday(tx: Db, auth: AuthContext, h: HolidayInput): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO holiday (tenant_id, name, from_date, to_date, kind, repeats_yearly, applies_to_all, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        auth.tenantId,
        h.name,
        h.fromDate,
        h.toDate,
        h.kind,
        h.repeatsYearly,
        h.appliesToAll,
        auth.userId,
      ],
    );
    const id = rows[0]!.id;
    await this.insertLocations(tx, auth, id, h);
    return id;
  }

  private async insertLocations(tx: Db, auth: AuthContext, id: string, h: HolidayInput) {
    for (const locationId of h.appliesToAll ? [] : [...new Set(h.locationIds)]) {
      await tx.query(
        "INSERT INTO holiday_location (tenant_id, holiday_id, location_id) VALUES ($1, $2, $3)",
        [auth.tenantId, id, locationId],
      );
    }
  }

  /** A change reaching today or the past needs an explicit confirmation (PRD 14.2). */
  private async assertRecompute(
    tx: Db,
    auth: AuthContext,
    date: string,
    confirmed: boolean | undefined,
  ): Promise<void> {
    const today = await tenantToday(tx, this.clock, auth.tenantId);
    if (date <= today && !confirmed) {
      throw new ApiError(
        409,
        "RECOMPUTE_CONFIRMATION_REQUIRED",
        "This holiday starts today or in the past, so attendance already recorded may change. Repeat the request with confirmRecompute: true.",
      );
    }
  }

  private mapError(error: unknown): unknown {
    if (pgCode(error) === "23505") {
      return new ApiError(
        409,
        "HOLIDAY_EXISTS",
        "A holiday with this name and start date already exists.",
      );
    }
    if (pgCode(error) === "23503") {
      return new ApiError(400, "LOCATION_NOT_FOUND", "One of the locations does not exist.");
    }
    return mapDbError(error);
  }
}
