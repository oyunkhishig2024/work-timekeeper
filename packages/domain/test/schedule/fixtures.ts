import type {
  AttendanceRules,
  ExpectationInput,
  ShiftPattern,
  ShiftTemplate,
  WorkingWeek,
  WorkingWeekDay,
} from "../../src";

export const CENTRAL = "loc-central";
export const NAIMAN = "loc-naiman-sharga";
export const TZ = "Asia/Ulaanbaatar"; // UTC+8, no daylight saving

// 2026-10-05 is a Monday; 10-10 a Saturday; 10-11 a Sunday.
export const MON = "2026-10-05";
export const TUE = "2026-10-06";
export const SAT = "2026-10-10";
export const SUN = "2026-10-11";

export const day = (weekday: number, start?: string, end?: string): WorkingWeekDay => ({
  weekday,
  working: start !== undefined,
  startTime: start ?? null,
  endTime: end ?? null,
});

/** Mon–Fri 08:30–17:30, Saturday and Sunday off (tenant 310, PRD 14.3). */
export const standardWeek = (over: Partial<WorkingWeek> = {}): WorkingWeek => ({
  locationId: null,
  validFrom: "2026-01-01",
  validTo: null,
  days: [
    day(1, "08:30", "17:30"),
    day(2, "08:30", "17:30"),
    day(3, "08:30", "17:30"),
    day(4, "08:30", "17:30"),
    day(5, "08:30", "17:30"),
    day(6),
    day(7),
  ],
  ...over,
});

/** Grace 15, no-show after 2 h, minimum stay 3 min, early window 2 h (PRD defaults). */
export const defaultRules = (over: Partial<AttendanceRules> = {}): AttendanceRules => ({
  locationId: null,
  validFrom: "2026-01-01",
  validTo: null,
  graceMinutes: 15,
  cutoffMinutes: 120,
  minStayMinutes: 3,
  earlyWindowMinutes: 120,
  ...over,
});

export const guard24h: ShiftTemplate = {
  id: "t-24h",
  startTime: "08:00",
  durationMinutes: 1440,
  graceMinutes: 15,
  cutoffMinutes: 120,
  earlyWindowMinutes: 120,
  observesHolidays: false,
};
export const night: ShiftTemplate = {
  id: "t-night",
  startTime: "20:00",
  durationMinutes: 720,
  graceMinutes: 10,
  cutoffMinutes: 60,
  earlyWindowMinutes: 30,
  observesHolidays: false,
};
export const dayShift: ShiftTemplate = {
  id: "t-day",
  startTime: "08:00",
  durationMinutes: 720,
  graceMinutes: 15,
  cutoffMinutes: 120,
  earlyWindowMinutes: 120,
  observesHolidays: true,
};
/** 24 h on, 48 h off. */
export const pattern24x48: ShiftPattern = {
  id: "p-24-48",
  cycleLengthDays: 3,
  days: ["t-24h", null, null],
};

/** An active standard-schedule employee at the central location, with the default configuration. */
export function baseInput(over: Partial<ExpectationInput> = {}): ExpectationInput {
  return {
    workDate: MON,
    tenantTimeZone: TZ,
    employee: {
      status: "ACTIVE",
      startDate: "2026-01-01",
      endDate: null,
      scheduleMode: "STANDARD",
      primaryLocationId: CENTRAL,
    },
    locations: [
      { id: CENTRAL, workingWeekMode: "INHERIT" },
      { id: NAIMAN, workingWeekMode: "INHERIT" },
    ],
    tempAssignments: [],
    workingWeeks: [standardWeek()],
    workingDayExceptions: [],
    holidays: [],
    rules: [defaultRules()],
    shifts: {
      templates: [guard24h, night, dayShift],
      patterns: [pattern24x48],
      assignments: [],
      overrides: [],
    },
    ...over,
  };
}

/** A guard on the 24/48 pattern whose day 0 is 2026-10-01. */
export function guardInput(over: Partial<ExpectationInput> = {}): ExpectationInput {
  const base = baseInput();
  return baseInput({
    employee: { ...base.employee, scheduleMode: "SHIFT" },
    shifts: {
      ...base.shifts,
      assignments: [
        {
          patternId: "p-24-48",
          templateId: null,
          cycleStartDate: "2026-10-01",
          fromDate: "2026-10-01",
          toDate: null,
        },
      ],
    },
    ...over,
  });
}
