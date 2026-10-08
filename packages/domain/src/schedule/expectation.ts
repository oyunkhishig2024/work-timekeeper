import { addDays, daysBetween, isoWeekday, positiveMod, type DateString } from "./dates";
import { isHoliday } from "./holidays";
import { pickVersion } from "./versions";
import { zonedTimeToInstant, instantToLocalDate } from "./zoned";
import type {
  AttendanceRules,
  EmployeeFacts,
  Expectation,
  ExpectationInput,
  MissingConfiguration,
  NotExpectedReason,
  ShiftAssignment,
  ShiftPattern,
  ShiftTemplate,
  WorkingDayException,
} from "./types";

const MS_PER_MINUTE = 60_000;

/** What is planned for the day, before rules and time zones are applied. */
type Duty =
  | { kind: "STANDARD"; startTime: string; endTime: string }
  | { kind: "SHIFT"; template: ShiftTemplate };

type Resolution = { duty: Duty } | { off: NotExpectedReason } | { missing: MissingConfiguration };

const notExpected = (reason: NotExpectedReason): Expectation => ({ expected: false, reason });
const notConfigured = (missing: MissingConfiguration): Expectation => ({
  expected: false,
  reason: "NOT_CONFIGURED",
  missing,
});

/**
 * Was the person employed on this date? The last working day is `endDate` itself, so a leaver is still expected
 * on their final day. A disabled employee without an end date is treated as not employed.
 */
export function isEmployedOn(employee: EmployeeFacts, date: DateString): boolean {
  if (employee.startDate !== null && date < employee.startDate) return false;
  if (employee.endDate !== null && date > employee.endDate) return false;
  if (employee.status !== "ACTIVE" && employee.endDate === null) return false;
  return true;
}

/** Temporary location assignment (inclusive range) wins over the primary location (PRD 6.1). */
export function expectedLocationId(input: ExpectationInput): string {
  const temporary = input.tempAssignments.find(
    (t) => t.fromDate <= input.workDate && input.workDate <= t.toDate,
  );
  return temporary?.locationId ?? input.employee.primaryLocationId;
}

/**
 * The single function that answers "must this employee attend on this work date, where and when?"
 * (PRD 6.1, 14, 23.5). Pure: no database, no clock. Order of precedence:
 *
 *  1. not employed on the date                       → not expected (INACTIVE)
 *  2. a shift override for the date (ADD/SWAP/REMOVE) → HR's explicit decision, wins over holidays
 *  3. employee on a shift schedule                    → the assignment decides; the working week is ignored;
 *                                                       a holiday only counts for templates that observe holidays
 *  4. standard schedule: working-day exception > holiday > working week
 *
 * The expected location is the temporary assignment if one covers the date, otherwise the primary location;
 * holidays, the working week and the rules are those of that location. Anything that has to be configured but is
 * missing is reported as NOT_CONFIGURED instead of being guessed.
 */
export function getExpectation(input: ExpectationInput): Expectation {
  const { workDate, employee } = input;
  if (!isEmployedOn(employee, workDate)) return notExpected("INACTIVE");

  const locationId = expectedLocationId(input);
  const location = input.locations.find((l) => l.id === locationId);
  if (!location) return notConfigured("LOCATION");
  const timeZone = location.timeZone ?? input.tenantTimeZone;

  const resolution = resolveDuty(input, locationId, location.workingWeekMode === "OVERRIDE");
  if ("off" in resolution) return notExpected(resolution.off);
  if ("missing" in resolution) return notConfigured(resolution.missing);

  const rules = pickVersion(input.rules, locationId, workDate);
  if (!rules) return notConfigured("ATTENDANCE_RULES");

  return buildExpectation(resolution.duty, rules, workDate, locationId, timeZone);
}

function resolveDuty(
  input: ExpectationInput,
  locationId: string,
  locationHasOwnWeek: boolean,
): Resolution {
  const { workDate, shifts } = input;

  const override = shifts.overrides.find((o) => o.workDate === workDate);
  if (override) {
    if (override.kind === "REMOVE") return { off: "SHIFT_OFF" };
    const template = shifts.templates.find((t) => t.id === override.templateId);
    return template ? { duty: { kind: "SHIFT", template } } : { missing: "SHIFT_TEMPLATE" };
  }

  if (input.employee.scheduleMode === "SHIFT") {
    const assignment = shifts.assignments.find(
      (a) => a.fromDate <= workDate && (a.toDate === null || workDate <= a.toDate),
    );
    if (!assignment) return { missing: "SHIFT_ASSIGNMENT" };

    const templateId = templateIdOnDate(assignment, shifts.patterns, workDate);
    if (templateId === "MISSING_PATTERN") return { missing: "SHIFT_PATTERN" };
    if (templateId === null) return { off: "SHIFT_OFF" };
    const template = shifts.templates.find((t) => t.id === templateId);
    if (!template) return { missing: "SHIFT_TEMPLATE" };
    if (template.observesHolidays && isHoliday(input.holidays, locationId, workDate))
      return { off: "HOLIDAY" };
    return { duty: { kind: "SHIFT", template } };
  }

  return resolveStandardDay(input, locationId, locationHasOwnWeek);
}

/** Template for the date: the fixed template, or day `(date - cycleStart) mod cycleLength` of the pattern (null = off). */
function templateIdOnDate(
  assignment: ShiftAssignment,
  patterns: readonly ShiftPattern[],
  date: DateString,
): string | null | "MISSING_PATTERN" {
  if (assignment.templateId !== null) return assignment.templateId;
  const pattern = patterns.find((p) => p.id === assignment.patternId);
  if (
    !pattern ||
    assignment.cycleStartDate === null ||
    pattern.days.length !== pattern.cycleLengthDays
  ) {
    return "MISSING_PATTERN";
  }
  const index = positiveMod(daysBetween(assignment.cycleStartDate, date), pattern.cycleLengthDays);
  return pattern.days[index] ?? null;
}

function resolveStandardDay(
  input: ExpectationInput,
  locationId: string,
  locationHasOwnWeek: boolean,
): Resolution {
  const { workDate } = input;
  const exception = pickException(input.workingDayExceptions, locationId, workDate);
  const weekday = isoWeekday(workDate);
  const weeklyHours = () => {
    const week = pickVersion(input.workingWeeks, locationId, workDate, locationHasOwnWeek);
    const day = week?.days.find((d) => d.weekday === weekday);
    return { week, day };
  };

  // A working-day exception beats both the holiday calendar and the weekly table (PRD 14.1).
  if (exception) {
    if (!exception.working) return { off: "OFF_DAY" };
    if (exception.startTime !== null && exception.endTime !== null) {
      return {
        duty: { kind: "STANDARD", startTime: exception.startTime, endTime: exception.endTime },
      };
    }
    const { day } = weeklyHours();
    return day?.working && day.startTime !== null && day.endTime !== null
      ? { duty: { kind: "STANDARD", startTime: day.startTime, endTime: day.endTime } }
      : { missing: "EXCEPTION_HOURS" };
  }

  if (isHoliday(input.holidays, locationId, workDate)) return { off: "HOLIDAY" };

  const { week, day } = weeklyHours();
  if (!week || !day) return { missing: "WORKING_WEEK" };
  if (!day.working) return { off: "OFF_DAY" };
  if (day.startTime === null || day.endTime === null) return { missing: "WORKING_WEEK" };
  return { duty: { kind: "STANDARD", startTime: day.startTime, endTime: day.endTime } };
}

/** The location's own exception for the date, otherwise the tenant-wide one. */
function pickException(
  exceptions: readonly WorkingDayException[],
  locationId: string,
  date: DateString,
): WorkingDayException | undefined {
  return (
    exceptions.find((e) => e.date === date && e.locationId === locationId) ??
    exceptions.find((e) => e.date === date && e.locationId === null)
  );
}

/** How long before a shift starts an entry still counts for it. */
const SHIFT_EARLY_LIMIT_MINUTES = 12 * 60;

function buildExpectation(
  duty: Duty,
  rules: AttendanceRules,
  workDate: DateString,
  locationId: string,
  timeZone: string,
): Expectation {
  const startTime = duty.kind === "SHIFT" ? duty.template.startTime : duty.startTime;
  const start = zonedTimeToInstant(workDate, startTime, timeZone);
  // A shift is a duration (it can cross midnight); a standard day ends at a wall-clock time on the same date.
  const end =
    duty.kind === "SHIFT"
      ? new Date(start.getTime() + duty.template.durationMinutes * MS_PER_MINUTE)
      : zonedTimeToInstant(workDate, duty.endTime, timeZone);
  // Grace belongs to the shift template for shifts and to the rule version otherwise.
  const timing = duty.kind === "SHIFT" ? duty.template : rules;
  // Arriving earlier is never a problem (PRD 6.2): a standard day counts entries from local midnight, a shift from 12 h
  // before it starts (a duty lasts at most 24 h, so the previous shift of the same person is over by then).
  const earlyWindowStart =
    duty.kind === "SHIFT"
      ? new Date(start.getTime() - SHIFT_EARLY_LIMIT_MINUTES * MS_PER_MINUTE)
      : zonedTimeToInstant(workDate, "00:00", timeZone);
  return {
    expected: true,
    source: duty.kind,
    workDate,
    locationId,
    timeZone,
    shiftTemplateId: duty.kind === "SHIFT" ? duty.template.id : null,
    start,
    end,
    graceMinutes: timing.graceMinutes,
    cutoff: end, // PRD 6.3: nobody is a no-show before the duty is over
    earlyWindowStart,
    minStayMinutes: rules.minStayMinutes,
  };
}

/**
 * The work dates an instant can belong to: the local date and the day before it. A duty lasts at most 24 h
 * (PRD 23.1), so an event at 01:30 may belong to a shift that started the previous evening (PRD 23.2).
 */
export function candidateWorkDates(
  instant: Date,
  timeZone: string,
): [previous: DateString, current: DateString] {
  const current = instantToLocalDate(instant, timeZone);
  return [addDays(current, -1), current];
}
