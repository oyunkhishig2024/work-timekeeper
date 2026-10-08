import { Injectable } from "@nestjs/common";
import {
  addDays,
  daysBetween,
  getExpectation,
  type AttendanceRules,
  type ExpectationInput,
  type Holiday,
  type ShiftAssignment,
  type ShiftOverride,
  type ShiftPattern,
  type ShiftTemplate,
  type WorkingDayException,
  type WorkingWeek,
} from "@timekeeper/domain";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { DatabaseService, type Db } from "../database/database.service";
import { ScopeService } from "../access/scope.service";
import type { AuthContext } from "../auth/auth.types";
import { DEFAULT_RULES } from "./attendance-rules.service";

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
  source: "STANDARD" | "SHIFT" | null;
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
      const data = await this.load(tx, auth.tenantId, f.from, f.to, ids);

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

  // ------------------------------------------------------------------ loading the function's inputs

  private async load(tx: Db, tenantId: string, from: string, to: string, employeeIds: string[]) {
    const tz = await tx.query<{ time_zone: string }>("SELECT time_zone FROM tenant WHERE id = $1", [
      tenantId,
    ]);
    const timeZone = tz.rows[0]?.time_zone ?? "Asia/Ulaanbaatar";

    const locations = (
      await tx.query<{ id: string; workingWeekMode: "INHERIT" | "OVERRIDE" }>(
        `SELECT id, working_week_mode AS "workingWeekMode" FROM location`,
      )
    ).rows;

    const weeks = (
      await tx.query<{
        id: string;
        locationId: string | null;
        validFrom: string;
        validTo: string | null;
      }>(
        `SELECT id, location_id AS "locationId", valid_from::text AS "validFrom", valid_to::text AS "validTo"
           FROM working_week_version WHERE valid_from <= $2 AND (valid_to IS NULL OR valid_to > $1)`,
        [from, to],
      )
    ).rows;
    const weekDays = (
      await tx.query<{
        weekId: string;
        weekday: number;
        working: boolean;
        start: string | null;
        end: string | null;
      }>(
        `SELECT working_week_id AS "weekId", weekday, working, to_char(start_time, 'HH24:MI') AS start,
                to_char(end_time, 'HH24:MI') AS "end"
           FROM working_week_day WHERE working_week_id = ANY($1::uuid[])`,
        [weeks.map((w) => w.id)],
      )
    ).rows;
    const workingWeeks: WorkingWeek[] = weeks.map((w) => ({
      locationId: w.locationId,
      validFrom: w.validFrom,
      validTo: w.validTo,
      days: weekDays
        .filter((d) => d.weekId === w.id)
        .map((d) => ({
          weekday: d.weekday,
          working: d.working,
          startTime: d.start,
          endTime: d.end,
        })),
    }));

    const exceptions = (
      await tx.query<WorkingDayException>(
        `SELECT location_id AS "locationId", exception_date::text AS date, working,
                to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
           FROM working_day_exception WHERE exception_date BETWEEN $1 AND $2`,
        [from, to],
      )
    ).rows;

    // Yearly holidays may have started in an earlier year, so every holiday is loaded (a tenant has tens of rows).
    const holidays: Holiday[] = (
      await tx.query<Holiday>(
        `SELECT h.from_date::text AS "fromDate", h.to_date::text AS "toDate", h.repeats_yearly AS "repeatsYearly",
                h.applies_to_all AS "appliesToAll",
                COALESCE((SELECT array_agg(hl.location_id::text) FROM holiday_location hl WHERE hl.holiday_id = h.id), '{}') AS "locationIds"
           FROM holiday h`,
      )
    ).rows;

    const ruleRows = (
      await tx.query<AttendanceRules>(
        `SELECT location_id AS "locationId", valid_from::text AS "validFrom", valid_to::text AS "validTo",
                grace_minutes AS "graceMinutes", cutoff_minutes AS "cutoffMinutes",
                min_stay_minutes AS "minStayMinutes", early_window_minutes AS "earlyWindowMinutes"
           FROM attendance_rule_version`,
      )
    ).rows;
    // Same fallback as GET /attendance-rules: the PRD defaults until a tenant-wide version exists.
    const rules: AttendanceRules[] = ruleRows.some((r) => r.locationId === null)
      ? ruleRows
      : [
          ...ruleRows,
          { locationId: null, validFrom: "1900-01-01", validTo: null, ...DEFAULT_RULES },
        ];

    const templates = (
      await tx.query<ShiftTemplate & { name: string; endTime: string }>(
        `SELECT id, name, to_char(start_time, 'HH24:MI') AS "startTime",
                to_char(start_time + make_interval(mins => duration_minutes), 'HH24:MI') AS "endTime",
                duration_minutes AS "durationMinutes", grace_minutes AS "graceMinutes",
                cutoff_minutes AS "cutoffMinutes", early_window_minutes AS "earlyWindowMinutes",
                observes_holidays AS "observesHolidays"
           FROM shift_template`,
      )
    ).rows;
    const patternRows = (
      await tx.query<{ id: string; cycleLengthDays: number; days: Array<string | null> }>(
        `SELECT p.id, p.cycle_length_days AS "cycleLengthDays",
                (SELECT json_agg(d.template_id ORDER BY d.day_index) FROM shift_pattern_day d WHERE d.pattern_id = p.id) AS days
           FROM shift_pattern p`,
      )
    ).rows;
    const patterns: ShiftPattern[] = patternRows.map((p) => ({
      id: p.id,
      cycleLengthDays: p.cycleLengthDays,
      days: p.days,
    }));

    const assignments = (
      await tx.query<ShiftAssignment & { employeeId: string }>(
        `SELECT employee_id AS "employeeId", pattern_id AS "patternId", template_id AS "templateId",
                cycle_start_date::text AS "cycleStartDate", from_date::text AS "fromDate", to_date::text AS "toDate"
           FROM shift_assignment
          WHERE employee_id = ANY($1::uuid[]) AND from_date <= $3 AND (to_date IS NULL OR to_date >= $2)`,
        [employeeIds, from, to],
      )
    ).rows;
    // A shift that starts the evening before the window can still end inside it, so overrides get one day of margin.
    const overrides = (
      await tx.query<ShiftOverride & { employeeId: string }>(
        `SELECT employee_id AS "employeeId", work_date::text AS "workDate", kind, template_id AS "templateId"
           FROM shift_override WHERE employee_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3`,
        [employeeIds, addDays(from, -1), to],
      )
    ).rows;
    const temps = (
      await tx.query<{ employeeId: string; locationId: string; fromDate: string; toDate: string }>(
        `SELECT employee_id AS "employeeId", location_id AS "locationId", from_date::text AS "fromDate", to_date::text AS "toDate"
           FROM temp_location_assignment WHERE employee_id = ANY($1::uuid[]) AND from_date <= $3 AND to_date >= $2`,
        [employeeIds, from, to],
      )
    ).rows;
    const reasons = (
      await tx.query<{ employeeId: string; name: string; fromDate: string; toDate: string | null }>(
        `SELECT a.employee_id AS "employeeId", r.name, a.from_date::text AS "fromDate", a.to_date::text AS "toDate"
           FROM reason_assignment a JOIN absence_reason r ON r.tenant_id = a.tenant_id AND r.id = a.reason_id
          WHERE a.employee_id = ANY($1::uuid[]) AND a.from_date <= $3 AND (a.to_date IS NULL OR a.to_date >= $2)`,
        [employeeIds, from, to],
      )
    ).rows;

    return {
      timeZone,
      locations,
      workingWeeks,
      exceptions,
      holidays,
      rules,
      templateNames: templates.map((t) => ({
        id: t.id,
        name: t.name,
        startTime: t.startTime,
        endTime: t.endTime,
      })),
      shiftsFor: (employeeId: string) => ({
        templates: templates as ShiftTemplate[],
        patterns,
        assignments: assignments.filter((a) => a.employeeId === employeeId),
        overrides: overrides.filter((o) => o.employeeId === employeeId),
      }),
      tempFor: (employeeId: string) => temps.filter((t) => t.employeeId === employeeId),
      reasonOn: (employeeId: string, date: string): string | null =>
        reasons.find(
          (r) =>
            r.employeeId === employeeId &&
            r.fromDate <= date &&
            (r.toDate === null || r.toDate >= date),
        )?.name ?? null,
    };
  }
}
