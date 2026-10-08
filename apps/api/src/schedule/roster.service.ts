import { Injectable } from "@nestjs/common";
import { addDays, daysBetween, getExpectation, type ExpectationInput } from "@timekeeper/domain";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { DatabaseService } from "../database/database.service";
import { ScopeService } from "../access/scope.service";
import type { AuthContext } from "../auth/auth.types";
import { ExpectationLoader } from "./expectation-loader.service";

export interface RosterFilter {
  from: string;
  to: string;
  departmentId?: string;
  locationId?: string;
  employeeId?: string;
  scheduleMode?: "STANDARD" | "SHIFT";
  limit: number;
  offset: number;
}

export interface RosterCell {
  date: string;
  expected: boolean;
  /** Why not expected (INACTIVE | HOLIDAY | OFF_DAY | SHIFT_OFF | NOT_CONFIGURED), or the source when expected. */
  reason: string | null;
  source: "STANDARD" | "SHIFT" | "PERSONAL" | null;
  missing: string | null;
  locationId: string | null;
  shiftTemplateId: string | null;
  /** Local start / end time at the duty location, "HH:MM". */
  start: string | null;
  end: string | null;
  endsNextDay: boolean;
  /** A reason assignment covers this date (PRD 6.6): the employee will be Шалтгаантай, not Ирээгүй. */
  absenceReason: string | null;
  /** A one-day override (ADD / REMOVE / SWAP) exists for this date (PRD 23.1). */
  override: "ADD" | "REMOVE" | "SWAP" | null;
  /** A planned duty collides with a reason assignment (PRD 23.5): HR should look at it. */
  conflict: boolean;
}

const MAX_DAYS = 62;

const localTime = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);

/**
 * Roster calendar (PRD 23.5): for each employee and date, what is expected — exactly what the attendance engine
 * will use, because every cell comes from `getExpectation` in packages/domain (no rule logic is repeated here).
 * This service only loads the data the function needs and shows its answer next to the reasons covering that date.
 */
@Injectable()
export class RosterService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
    private readonly loader: ExpectationLoader,
  ) {}

  async roster(auth: AuthContext, f: RosterFilter) {
    const days = daysBetween(f.from, f.to) + 1;
    if (days < 1) throw new ApiError(400, "INVALID_DATES", "`to` is before `from`.");
    if (days > MAX_DAYS) {
      throw new ApiError(400, "RANGE_TOO_LONG", `The roster shows at most ${MAX_DAYS} days.`);
    }
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const params: unknown[] = [];
      const where: string[] = [this.scopes.employeeCondition(scope, "e", params)];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      // Employees who left before the window are not on the roster.
      add(
        "(e.status = 'ACTIVE' OR (e.status = 'DISABLED' AND (e.end_date IS NULL OR e.end_date >= ?::date)))",
        f.from,
      );
      if (f.departmentId) add("e.department_id = ?", f.departmentId);
      if (f.locationId) add("e.primary_location_id = ?", f.locationId);
      if (f.employeeId) add("e.id = ?", f.employeeId);
      if (f.scheduleMode) add("e.schedule_mode = ?", f.scheduleMode);
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM employee e WHERE ${where.join(" AND ")}`,
        params,
      );
      params.push(f.limit, f.offset);
      const { rows: employees } = await tx.query<{
        id: string;
        employeeNo: string;
        fullName: string;
        status: "ACTIVE" | "DISABLED" | "ARCHIVED";
        startDate: string | null;
        endDate: string | null;
        scheduleMode: "STANDARD" | "SHIFT";
        primaryLocationId: string;
      }>(
        `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.status,
                e.start_date::text AS "startDate", e.end_date::text AS "endDate",
                e.schedule_mode AS "scheduleMode", e.primary_location_id AS "primaryLocationId"
           FROM employee e WHERE ${where.join(" AND ")}
          ORDER BY e.employee_no, e.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const dates = Array.from({ length: days }, (_, i) => addDays(f.from, i));
      const ids = employees.map((e) => e.id);
      const data = await this.loader.load(tx, auth.tenantId, f.from, f.to, ids);

      const items = employees.map((e) => {
        const shifts = data.shiftsFor(e.id);
        const cells = dates.map((date): RosterCell => {
          const input: ExpectationInput = {
            workDate: date,
            tenantTimeZone: data.timeZone,
            employee: {
              status: e.status,
              startDate: e.startDate,
              endDate: e.endDate,
              scheduleMode: e.scheduleMode,
              primaryLocationId: e.primaryLocationId,
            },
            locations: data.locations,
            tempAssignments: data.tempFor(e.id),
            workingWeeks: data.workingWeeks,
            workingDayExceptions: data.exceptions,
            holidays: data.holidays,
            rules: data.rules,
            personalHours: data.personalFor(e.id),
            shifts,
          };
          const x = getExpectation(input);
          const absenceReason = data.reasonOn(e.id, date);
          const override = shifts.overrides.find((o) => o.workDate === date)?.kind ?? null;
          if (x.expected) {
            const start = localTime(x.start, x.timeZone);
            const end = localTime(x.end, x.timeZone);
            return {
              date,
              expected: true,
              reason: null,
              source: x.source,
              missing: null,
              locationId: x.locationId,
              shiftTemplateId: x.shiftTemplateId,
              start,
              end,
              endsNextDay: x.end.getTime() - x.start.getTime() >= 24 * 3_600_000 || end <= start,
              absenceReason,
              override,
              conflict: absenceReason !== null,
            };
          }
          return {
            date,
            expected: false,
            reason: x.reason,
            source: null,
            missing: x.reason === "NOT_CONFIGURED" ? x.missing : null,
            locationId: null,
            shiftTemplateId: null,
            start: null,
            end: null,
            endsNextDay: false,
            absenceReason,
            override,
            conflict: false,
          };
        });
        return {
          employeeId: e.id,
          employeeNo: e.employeeNo,
          fullName: e.fullName,
          scheduleMode: e.scheduleMode,
          primaryLocationId: e.primaryLocationId,
          conflicts: cells.filter((c) => c.conflict).length,
          cells,
        };
      });
      return {
        from: f.from,
        to: f.to,
        dates,
        total: total.rows[0]!.n,
        limit: f.limit,
        offset: f.offset,
        templates: data.templateNames,
        conflicts: items.reduce((n, i) => n + i.conflicts, 0),
        items,
      };
    });
  }
}
