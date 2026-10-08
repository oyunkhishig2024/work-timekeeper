import type { DateString } from "./dates";
import type { Holiday } from "./holidays";

/** Employment facts from the employee record (PRD 12). */
export interface EmployeeFacts {
  status: "ACTIVE" | "DISABLED" | "ARCHIVED";
  startDate: DateString | null;
  /** Last day of employment; set when the employee is disabled (PRD 12.2). */
  endDate: DateString | null;
  scheduleMode: "STANDARD" | "SHIFT";
  primaryLocationId: string;
}

export interface LocationFacts {
  id: string;
  /** INHERIT: use the tenant working week; OVERRIDE: the location has its own (PRD 14.1). */
  workingWeekMode: "INHERIT" | "OVERRIDE";
  /** IANA zone; defaults to the tenant zone (PRD 22.2). */
  timeZone?: string;
}

/** Temporary location assignment, both dates inclusive (PRD 12.1). */
export interface TempAssignment {
  locationId: string;
  fromDate: DateString;
  toDate: DateString;
}

/** Validity is half-open: [validFrom, validTo); validTo null = until further notice (PRD 22.1). */
export interface Versioned {
  /** null = the tenant default; otherwise the location it belongs to. */
  locationId: string | null;
  validFrom: DateString;
  validTo: DateString | null;
}

export interface WorkingWeekDay {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  working: boolean;
  startTime: string | null;
  endTime: string | null;
}

export interface WorkingWeek extends Versioned {
  days: readonly WorkingWeekDay[];
}

export interface WorkingDayException {
  locationId: string | null;
  date: DateString;
  working: boolean;
  /** Both null: use the weekly hours of that weekday. */
  startTime: string | null;
  endTime: string | null;
}

export interface AttendanceRules extends Versioned {
  graceMinutes: number;
  minStayMinutes: number;
}

export interface ShiftTemplate {
  id: string;
  startTime: string;
  durationMinutes: number;
  graceMinutes: number;
  observesHolidays: boolean;
}

export interface ShiftPattern {
  id: string;
  cycleLengthDays: number;
  /** Day i of the cycle: a template id (working) or null (off). Length = cycleLengthDays. */
  days: readonly (string | null)[];
}

export interface ShiftAssignment {
  /** Exactly one of patternId / templateId. */
  patternId: string | null;
  templateId: string | null;
  /** Day 0 of the cycle (required for patterns). */
  cycleStartDate: DateString | null;
  fromDate: DateString;
  /** Inclusive; null = open-ended. */
  toDate: DateString | null;
}

export interface ShiftOverride {
  workDate: DateString;
  kind: "ADD" | "REMOVE" | "SWAP";
  templateId: string | null;
}

/**
 * Hours fixed by HR for one employee over a range of dates (PRD 14.3, v1.26): "come at 06:30 tomorrow and the day after".
 * They replace whatever the week, a holiday or a shift would say for those dates. Several places mean the person works
 * at all of them that day; the first is the main one. No places: the employee's usual expected place.
 */
export interface PersonalHours {
  fromDate: DateString;
  /** Inclusive. */
  toDate: DateString;
  startTime: string;
  /** Later than `startTime` on the same date. */
  endTime: string;
  locationIds: readonly string[];
}

/** Everything the function needs, as plain data loaded by the caller (no database access here). */
export interface ExpectationInput {
  /** The work date: for a shift, the date it starts (PRD 23.2). */
  workDate: DateString;
  tenantTimeZone: string;
  employee: EmployeeFacts;
  locations: readonly LocationFacts[];
  tempAssignments: readonly TempAssignment[];
  workingWeeks: readonly WorkingWeek[];
  workingDayExceptions: readonly WorkingDayException[];
  holidays: readonly Holiday[];
  rules: readonly AttendanceRules[];
  /** This employee's personal hours only (PRD 14.3). Optional: absent means none. */
  personalHours?: readonly PersonalHours[];
  shifts: {
    templates: readonly ShiftTemplate[];
    patterns: readonly ShiftPattern[];
    /** This employee's assignments and overrides only. */
    assignments: readonly ShiftAssignment[];
    overrides: readonly ShiftOverride[];
  };
}

export type NotExpectedReason = "INACTIVE" | "HOLIDAY" | "OFF_DAY" | "SHIFT_OFF";

/** Something that must be configured before attendance can be evaluated; surfaced to HR, never guessed. */
export type MissingConfiguration =
  | "LOCATION"
  | "WORKING_WEEK"
  | "ATTENDANCE_RULES"
  | "EXCEPTION_HOURS"
  | "SHIFT_ASSIGNMENT"
  | "SHIFT_TEMPLATE"
  | "SHIFT_PATTERN";

/**
 * Who must attend, where and when, on one work date (PRD 6.1, 23.5). The attendance engine, summaries and
 * reports consume only this; they never read schedule tables themselves.
 */
export type Expectation =
  | { expected: false; reason: NotExpectedReason }
  | { expected: false; reason: "NOT_CONFIGURED"; missing: MissingConfiguration }
  | {
      expected: true;
      source: "STANDARD" | "SHIFT" | "PERSONAL";
      /** The date the day/shift starts, in the location time zone. */
      workDate: DateString;
      locationId: string;
      /** Every place that counts for the duty: the main one first, more only with personal hours (PRD 14.3). */
      locationIds: string[];
      timeZone: string;
      shiftTemplateId: string | null;
      /** Absolute instants. */
      start: Date;
      end: Date;
      graceMinutes: number;
      /** The end of the duty: no arrival and no reason by this instant means no-show (PRD 6.3). */
      cutoff: Date;
      /** Entries before this instant do not count for this duty; any earlier arrival is on time (PRD 6.2, 23.2). */
      earlyWindowStart: Date;
      minStayMinutes: number;
    };
