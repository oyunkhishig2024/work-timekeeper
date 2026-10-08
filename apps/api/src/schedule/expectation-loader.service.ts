import { Injectable } from "@nestjs/common";
import {
  addDays,
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
import type { Db } from "../database/database.service";
import { DEFAULT_RULES } from "./attendance-rules.service";

export type ExpectationData = Awaited<ReturnType<ExpectationLoader["load"]>>;

export interface EmployeeRow {
  status: "ACTIVE" | "DISABLED" | "ARCHIVED";
  startDate: string | null;
  endDate: string | null;
  scheduleMode: "STANDARD" | "SHIFT";
  primaryLocationId: string;
  id: string;
}

/**
 * Loads every piece of data `getExpectation` needs for a set of employees and a date window (PRD 6.1, 23.5).
 * Shared by the roster calendar and the attendance engine so both answer "who is expected when" identically.
 */
@Injectable()
export class ExpectationLoader {
  /** The plain-data input for one employee and work date. */
  inputFor(data: ExpectationData, e: EmployeeRow, date: string): ExpectationInput {
    return {
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
      shifts: data.shiftsFor(e.id),
    };
  }

  async load(tx: Db, tenantId: string, from: string, to: string, employeeIds: string[]) {
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
                grace_minutes AS "graceMinutes", min_stay_minutes AS "minStayMinutes"
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
      await tx.query<{
        employeeId: string;
        name: string;
        description: string | null;
        fromDate: string;
        toDate: string | null;
      }>(
        `SELECT a.employee_id AS "employeeId", r.name, a.description, a.from_date::text AS "fromDate", a.to_date::text AS "toDate"
           FROM reason_assignment a JOIN absence_reason r ON r.tenant_id = a.tenant_id AND r.id = a.reason_id
          WHERE a.employee_id = ANY($1::uuid[]) AND a.from_date <= $3 AND (a.to_date IS NULL OR a.to_date >= $2)`,
        [employeeIds, from, to],
      )
    ).rows;

    const coveringReason = (employeeId: string, date: string) =>
      reasons.find(
        (r) =>
          r.employeeId === employeeId &&
          r.fromDate <= date &&
          (r.toDate === null || r.toDate >= date),
      );

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
        coveringReason(employeeId, date)?.name ?? null,
      /** The written explanation of that reason («Бусад» needs one), if any. */
      reasonNoteOn: (employeeId: string, date: string): string | null =>
        coveringReason(employeeId, date)?.description ?? null,
    };
  }
}
