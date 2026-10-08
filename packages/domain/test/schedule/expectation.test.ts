import { describe, expect, it } from "vitest";
import {
  expectedLocationId,
  getExpectation,
  isEmployedOn,
  type Expectation,
  type ExpectationInput,
} from "../../src";
import {
  baseInput,
  CENTRAL,
  defaultRules,
  guard24h,
  guardInput,
  MON,
  NAIMAN,
  night,
  SAT,
  standardWeek,
  SUN,
  TUE,
  day,
} from "./fixtures";

const iso = (d: Date) => d.toISOString();
const run = (input: ExpectationInput) => getExpectation(input);
type Expected = Extract<Expectation, { expected: true }>;
const expectDuty = (e: Expectation): Expected => {
  expect(e.expected).toBe(true);
  return e as Expected;
};

describe("getExpectation — standard schedule (PRD 14, 6.1)", () => {
  it("Monday at the central location: 08:30–17:30 local, grace 15, no-show after 2 h, minimum stay 3", () => {
    const e = expectDuty(run(baseInput()));
    expect(e).toMatchObject({
      source: "STANDARD",
      workDate: MON,
      locationId: CENTRAL,
      timeZone: "Asia/Ulaanbaatar",
      shiftTemplateId: null,
      graceMinutes: 15,
      minStayMinutes: 3,
    });
    expect(iso(e.start)).toBe("2026-10-05T00:30:00.000Z"); // 08:30 UTC+8
    expect(iso(e.end)).toBe("2026-10-05T09:30:00.000Z"); // 17:30
    expect(iso(e.cutoff)).toBe("2026-10-05T09:30:00.000Z"); // 17:30: the end of the day (PRD 6.3)
    expect(iso(e.earlyWindowStart)).toBe("2026-10-04T16:00:00.000Z"); // local midnight: any earlier arrival is on time
  });

  it("weekends are off days", () => {
    expect(run(baseInput({ workDate: SAT }))).toEqual({ expected: false, reason: "OFF_DAY" });
    expect(run(baseInput({ workDate: SUN }))).toEqual({ expected: false, reason: "OFF_DAY" });
  });

  it("uses different hours on different weekdays", () => {
    const friShort = standardWeek({
      days: [
        day(1, "08:30", "17:30"),
        day(2, "08:30", "17:30"),
        day(3, "08:30", "17:30"),
        day(4, "08:30", "17:30"),
        day(5, "08:30", "16:00"),
        day(6),
        day(7),
      ],
    });
    const e = expectDuty(run(baseInput({ workDate: "2026-10-09", workingWeeks: [friShort] })));
    expect(iso(e.end)).toBe("2026-10-09T08:00:00.000Z");
  });

  it("applies the rule values of the version in force", () => {
    const rules = [
      defaultRules({ validTo: "2026-10-06", graceMinutes: 15 }),
      defaultRules({
        validFrom: "2026-10-06",
        graceMinutes: 5,
        minStayMinutes: 5,
      }),
    ];
    expect(expectDuty(run(baseInput({ workDate: MON, rules }))).graceMinutes).toBe(15); // valid_to is exclusive
    const tue = expectDuty(run(baseInput({ workDate: TUE, rules })));
    expect(tue).toMatchObject({ graceMinutes: 5, minStayMinutes: 5 });
  });

  it("a location's rules override the tenant default", () => {
    const rules = [defaultRules(), defaultRules({ locationId: CENTRAL, graceMinutes: 30 })];
    expect(expectDuty(run(baseInput({ rules }))).graceMinutes).toBe(30);
    expect(
      expectDuty(
        run(baseInput({ rules, employee: { ...baseInput().employee, primaryLocationId: NAIMAN } })),
      ).graceMinutes,
    ).toBe(15);
  });

  it("a location uses its own working week only when set to OVERRIDE", () => {
    const own = standardWeek({
      locationId: CENTRAL,
      days: [
        day(1, "09:00", "18:00"),
        day(2, "09:00", "18:00"),
        day(3, "09:00", "18:00"),
        day(4, "09:00", "18:00"),
        day(5, "09:00", "18:00"),
        day(6, "09:00", "13:00"),
        day(7),
      ],
    });
    const weeks = [standardWeek(), own];
    const inherit = expectDuty(run(baseInput({ workingWeeks: weeks })));
    expect(iso(inherit.start)).toBe("2026-10-05T00:30:00.000Z"); // tenant week 08:30
    const overrideInput = baseInput({
      workingWeeks: weeks,
      locations: [
        { id: CENTRAL, workingWeekMode: "OVERRIDE" },
        { id: NAIMAN, workingWeekMode: "INHERIT" },
      ],
    });
    expect(iso(expectDuty(run(overrideInput)).start)).toBe("2026-10-05T01:00:00.000Z"); // 09:00
    expect(expectDuty(run({ ...overrideInput, workDate: SAT })).source).toBe("STANDARD"); // its own Saturday hours
  });

  it("falls back to the tenant week when an OVERRIDE location has no version in force", () => {
    const own = standardWeek({ locationId: CENTRAL, validFrom: "2027-01-01" });
    const input = baseInput({
      workingWeeks: [standardWeek(), own],
      locations: [
        { id: CENTRAL, workingWeekMode: "OVERRIDE" },
        { id: NAIMAN, workingWeekMode: "INHERIT" },
      ],
    });
    expect(iso(expectDuty(run(input)).start)).toBe("2026-10-05T00:30:00.000Z");
  });

  it("switches to a newer working week on its first day", () => {
    const weeks = [
      standardWeek({ validTo: "2026-10-06" }),
      standardWeek({
        validFrom: "2026-10-06",
        days: [
          day(1),
          day(2, "10:00", "19:00"),
          day(3, "10:00", "19:00"),
          day(4, "10:00", "19:00"),
          day(5, "10:00", "19:00"),
          day(6),
          day(7),
        ],
      }),
    ];
    expect(run(baseInput({ workDate: MON, workingWeeks: weeks })).expected).toBe(true);
    expect(iso(expectDuty(run(baseInput({ workDate: TUE, workingWeeks: weeks }))).start)).toBe(
      "2026-10-06T02:00:00.000Z",
    );
  });
});

describe("getExpectation — holidays and exceptions (PRD 14.1, 14.2)", () => {
  const holiday = (over = {}) => ({
    fromDate: MON,
    toDate: MON,
    repeatsYearly: false,
    appliesToAll: true,
    locationIds: [],
    ...over,
  });

  it("a holiday makes the standard day not expected", () => {
    expect(run(baseInput({ holidays: [holiday()] }))).toEqual({
      expected: false,
      reason: "HOLIDAY",
    });
  });

  it("a yearly holiday applies in later years", () => {
    const yearly = holiday({ fromDate: "2025-10-05", toDate: "2025-10-05", repeatsYearly: true });
    expect(run(baseInput({ holidays: [yearly] }))).toEqual({ expected: false, reason: "HOLIDAY" });
  });

  it("a holiday limited to other locations does not affect this one", () => {
    const naimanOnly = holiday({ appliesToAll: false, locationIds: [NAIMAN] });
    expect(run(baseInput({ holidays: [naimanOnly] })).expected).toBe(true);
    expect(
      run(baseInput({ holidays: [holiday({ appliesToAll: false, locationIds: [CENTRAL] })] })),
    ).toEqual({ expected: false, reason: "HOLIDAY" });
  });

  it("a working-day exception turns a Saturday into a working day, with its own hours", () => {
    const e = expectDuty(
      run(
        baseInput({
          workDate: SAT,
          workingDayExceptions: [
            { locationId: null, date: SAT, working: true, startTime: "09:00", endTime: "13:00" },
          ],
        }),
      ),
    );
    expect(iso(e.start)).toBe("2026-10-10T01:00:00.000Z");
    expect(iso(e.end)).toBe("2026-10-10T05:00:00.000Z");
  });

  it("an exception without hours on a working weekday keeps the weekly hours", () => {
    const e = expectDuty(
      run(
        baseInput({
          workingDayExceptions: [
            { locationId: null, date: MON, working: true, startTime: null, endTime: null },
          ],
        }),
      ),
    );
    expect(iso(e.start)).toBe("2026-10-05T00:30:00.000Z");
  });

  it("an exception without hours on an off weekday has no hours to use — reported, not guessed", () => {
    const input = baseInput({
      workDate: SAT,
      workingDayExceptions: [
        { locationId: null, date: SAT, working: true, startTime: null, endTime: null },
      ],
    });
    expect(run(input)).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "EXCEPTION_HOURS",
    });
  });

  it("a working-day exception beats a holiday; an off exception beats a working weekday", () => {
    const worked = baseInput({
      holidays: [holiday()],
      workingDayExceptions: [
        { locationId: null, date: MON, working: true, startTime: "09:00", endTime: "12:00" },
      ],
    });
    expect(run(worked).expected).toBe(true);
    const off = baseInput({
      workingDayExceptions: [
        { locationId: null, date: MON, working: false, startTime: null, endTime: null },
      ],
    });
    expect(run(off)).toEqual({ expected: false, reason: "OFF_DAY" });
  });

  it("a location's exception beats the tenant-wide one", () => {
    const exceptions = [
      { locationId: null, date: SAT, working: true, startTime: "09:00", endTime: "13:00" },
      { locationId: CENTRAL, date: SAT, working: false, startTime: null, endTime: null },
    ];
    expect(run(baseInput({ workDate: SAT, workingDayExceptions: exceptions }))).toEqual({
      expected: false,
      reason: "OFF_DAY",
    });
    const naiman = baseInput({
      workDate: SAT,
      workingDayExceptions: exceptions,
      employee: { ...baseInput().employee, primaryLocationId: NAIMAN },
    });
    expect(run(naiman).expected).toBe(true);
  });
});

describe("getExpectation — employment and location (PRD 6.1, 12.1, 12.2)", () => {
  const employee = (over = {}) => ({ ...baseInput().employee, ...over });

  it("is not expected before the start date and after the last day; the last day itself counts", () => {
    expect(isEmployedOn(employee({ startDate: "2026-10-06" }), MON)).toBe(false);
    expect(isEmployedOn(employee({ startDate: MON }), MON)).toBe(true);
    expect(isEmployedOn(employee({ status: "DISABLED", endDate: MON }), MON)).toBe(true);
    expect(isEmployedOn(employee({ status: "DISABLED", endDate: MON }), TUE)).toBe(false);
    expect(isEmployedOn(employee({ status: "DISABLED", endDate: null }), MON)).toBe(false);
    expect(isEmployedOn(employee({ status: "ARCHIVED", endDate: "2026-12-31" }), MON)).toBe(true); // history stays computable
    expect(isEmployedOn(employee({ startDate: null }), MON)).toBe(true);
    expect(
      run(baseInput({ employee: employee({ status: "DISABLED", endDate: "2026-10-01" }) })),
    ).toEqual({ expected: false, reason: "INACTIVE" });
  });

  it("a temporary assignment moves the employee to that location, using its holidays and week (inclusive dates)", () => {
    const temp = [{ locationId: NAIMAN, fromDate: MON, toDate: TUE }];
    expect(expectedLocationId(baseInput({ tempAssignments: temp }))).toBe(NAIMAN);
    expect(expectedLocationId(baseInput({ tempAssignments: temp, workDate: TUE }))).toBe(NAIMAN);
    expect(expectedLocationId(baseInput({ tempAssignments: temp, workDate: "2026-10-07" }))).toBe(
      CENTRAL,
    );
    expect(expectedLocationId(baseInput({ tempAssignments: temp, workDate: "2026-10-04" }))).toBe(
      CENTRAL,
    );

    const naimanHoliday = {
      fromDate: MON,
      toDate: MON,
      repeatsYearly: false,
      appliesToAll: false,
      locationIds: [NAIMAN],
    };
    expect(run(baseInput({ tempAssignments: temp, holidays: [naimanHoliday] }))).toEqual({
      expected: false,
      reason: "HOLIDAY",
    });
    expect(run(baseInput({ holidays: [naimanHoliday] })).expected).toBe(true); // at home it is a normal Monday
    expect(expectDuty(run(baseInput({ tempAssignments: temp }))).locationId).toBe(NAIMAN);
  });

  it("uses the location's time zone when it has one", () => {
    const input = baseInput({
      locations: [
        { id: CENTRAL, workingWeekMode: "INHERIT", timeZone: "Asia/Tokyo" },
        { id: NAIMAN, workingWeekMode: "INHERIT" },
      ],
    });
    const e = expectDuty(run(input));
    expect(e.timeZone).toBe("Asia/Tokyo");
    expect(iso(e.start)).toBe("2026-10-04T23:30:00.000Z"); // 08:30 UTC+9
  });
});

describe("getExpectation — missing configuration is reported, never guessed", () => {
  it.each([
    ["no working week", baseInput({ workingWeeks: [] }), "WORKING_WEEK"],
    [
      "a week that does not cover the date",
      baseInput({ workingWeeks: [standardWeek({ validFrom: "2027-01-01" })] }),
      "WORKING_WEEK",
    ],
    [
      "a week missing the weekday",
      baseInput({ workingWeeks: [standardWeek({ days: [day(2, "08:30", "17:30")] })] }),
      "WORKING_WEEK",
    ],
    ["no attendance rules", baseInput({ rules: [] }), "ATTENDANCE_RULES"],
    ["an unknown primary location", baseInput({ locations: [] }), "LOCATION"],
  ])("%s → NOT_CONFIGURED", (_label, input, missing) => {
    expect(run(input)).toEqual({ expected: false, reason: "NOT_CONFIGURED", missing });
  });

  it("a day that is not expected does not need rules", () => {
    expect(run(baseInput({ workDate: SAT, rules: [] }))).toEqual({
      expected: false,
      reason: "OFF_DAY",
    });
  });
});

describe("getExpectation — shifts (PRD 23)", () => {
  it("24 h on / 48 h off: works on day 0 of each 3-day cycle, off on the other two", () => {
    const cases: [string, boolean][] = [
      ["2026-10-01", true],
      ["2026-10-02", false],
      ["2026-10-03", false],
      ["2026-10-04", true],
      ["2026-10-05", false],
      ["2026-10-06", false],
      ["2026-10-07", true],
    ];
    for (const [date, works] of cases) {
      const e = run(guardInput({ workDate: date }));
      expect(e.expected, date).toBe(works);
      if (!works) expect(e).toEqual({ expected: false, reason: "SHIFT_OFF" });
    }
  });

  it("a 24 h shift runs from 08:00 to 08:00 the next day and ignores the weekend rule", () => {
    const e = expectDuty(run(guardInput({ workDate: "2026-10-10" }))); // a Saturday, 10 = day 0 + 9
    expect(e).toMatchObject({ source: "SHIFT", shiftTemplateId: "t-24h", workDate: "2026-10-10" });
    expect(iso(e.start)).toBe("2026-10-10T00:00:00.000Z"); // 08:00 local
    expect(iso(e.end)).toBe("2026-10-11T00:00:00.000Z"); // 08:00 next day
    expect(iso(e.cutoff)).toBe("2026-10-11T00:00:00.000Z"); // the end of the shift
  });

  it("a night shift crosses midnight and belongs to the day it starts (PRD 23.2)", () => {
    const input = guardInput({
      workDate: MON,
      shifts: {
        ...baseInput().shifts,
        assignments: [
          {
            patternId: null,
            templateId: "t-night",
            cycleStartDate: null,
            fromDate: "2026-10-01",
            toDate: null,
          },
        ],
      },
    });
    const e = expectDuty(run(input));
    expect(e.workDate).toBe(MON);
    expect(iso(e.start)).toBe("2026-10-05T12:00:00.000Z"); // 20:00 local
    expect(iso(e.end)).toBe("2026-10-06T00:00:00.000Z"); // 08:00 local next day
  });

  it("takes grace, cut-off and early window from the template, minimum stay from the rules", () => {
    const input = guardInput({
      workDate: MON,
      shifts: {
        ...baseInput().shifts,
        assignments: [
          {
            patternId: null,
            templateId: "t-night",
            cycleStartDate: null,
            fromDate: "2026-10-01",
            toDate: null,
          },
        ],
      },
      rules: [
        defaultRules({
          graceMinutes: 99,
          minStayMinutes: 4,
        }),
      ],
    });
    const e = expectDuty(run(input));
    expect(e.graceMinutes).toBe(night.graceMinutes);
    expect(iso(e.cutoff)).toBe(iso(e.end)); // 08:00 next day: a no-show only once the shift is over
    expect(iso(e.earlyWindowStart)).toBe("2026-10-05T00:00:00.000Z"); // 12 h before 20:00 local
    expect(e.minStayMinutes).toBe(4);
  });

  it("works on public holidays unless the template observes them", () => {
    const holidays = [
      {
        fromDate: "2026-10-01",
        toDate: "2026-10-01",
        repeatsYearly: false,
        appliesToAll: true,
        locationIds: [],
      },
    ];
    expect(run(guardInput({ workDate: "2026-10-01", holidays })).expected).toBe(true); // guard24h does not observe holidays
    const observing = guardInput({
      workDate: MON,
      holidays: [{ ...holidays[0]!, fromDate: MON, toDate: MON }],
      shifts: {
        ...baseInput().shifts,
        assignments: [
          {
            patternId: null,
            templateId: "t-day",
            cycleStartDate: null,
            fromDate: "2026-10-01",
            toDate: null,
          },
        ],
      },
    });
    expect(run(observing)).toEqual({ expected: false, reason: "HOLIDAY" });
  });

  it("a fixed template applies every day of the assignment range (end inclusive, open-ended allowed)", () => {
    const assignment = {
      patternId: null,
      templateId: "t-day",
      cycleStartDate: null,
      fromDate: MON,
      toDate: TUE,
    };
    const input = (workDate: string) =>
      guardInput({ workDate, shifts: { ...baseInput().shifts, assignments: [assignment] } });
    expect(run(input(MON)).expected).toBe(true);
    expect(run(input(TUE)).expected).toBe(true);
    expect(run(input("2026-10-07"))).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_ASSIGNMENT",
    });
    expect(run(input("2026-10-04"))).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_ASSIGNMENT",
    });
  });

  it("dates before the cycle start still land on the right day of the cycle", () => {
    const input = (workDate: string) =>
      guardInput({
        workDate,
        employee: { ...baseInput().employee, scheduleMode: "SHIFT", startDate: "2026-01-01" },
        shifts: {
          ...baseInput().shifts,
          assignments: [
            {
              patternId: "p-24-48",
              templateId: null,
              cycleStartDate: "2026-10-04",
              fromDate: "2026-09-01",
              toDate: null,
            },
          ],
        },
      });
    expect(run(input("2026-10-04")).expected).toBe(true); // day 0
    expect(run(input("2026-10-01")).expected).toBe(true); // 3 days earlier = day 0 again
    expect(run(input("2026-10-02")).expected).toBe(false);
    expect(run(input("2026-09-28")).expected).toBe(true);
  });

  it("counts backwards correctly when the duty is not on day 0 of the cycle", () => {
    const shifts = {
      ...baseInput().shifts,
      patterns: [{ id: "p-mid", cycleLengthDays: 3, days: [null, "t-24h", null] }],
      assignments: [
        {
          patternId: "p-mid",
          templateId: null,
          cycleStartDate: "2026-10-04",
          fromDate: "2026-09-01",
          toDate: null,
        },
      ],
    };
    const works = (workDate: string) => run(guardInput({ workDate, shifts })).expected;
    // Day 1 of the cycle is on duty: 10-05, and going backwards 10-02, 09-29, 09-26.
    expect([
      works("2026-10-05"),
      works("2026-10-02"),
      works("2026-09-29"),
      works("2026-09-26"),
    ]).toEqual([true, true, true, true]);
    expect([works("2026-10-04"), works("2026-10-03"), works("2026-10-01")]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("two guards on the same pattern with different cycle starts cover alternate days", () => {
    const withOffset = (cycleStartDate: string, workDate: string) =>
      guardInput({
        workDate,
        shifts: {
          ...baseInput().shifts,
          assignments: [
            {
              patternId: "p-24-48",
              templateId: null,
              cycleStartDate,
              fromDate: "2026-10-01",
              toDate: null,
            },
          ],
        },
      });
    for (const date of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
      const works = [
        run(withOffset("2026-10-01", date)).expected,
        run(withOffset("2026-10-02", date)).expected,
        run(withOffset("2026-10-03", date)).expected,
      ];
      expect(works.filter(Boolean)).toHaveLength(1); // exactly one of the three rotations is on duty each day
    }
  });

  it("a long run of days repeats with the cycle length", () => {
    for (let n = 0; n < 60; n += 1) {
      const date = new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);
      expect(run(guardInput({ workDate: date })).expected, date).toBe(n % 3 === 0);
    }
  });

  it("a shift employee without an assignment, or with a broken pattern, is reported", () => {
    expect(run(guardInput({ shifts: { ...baseInput().shifts, assignments: [] } }))).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_ASSIGNMENT",
    });
    const broken = (over: object) =>
      guardInput({
        workDate: "2026-10-01",
        shifts: {
          ...baseInput().shifts,
          assignments: [
            {
              patternId: "p-24-48",
              templateId: null,
              cycleStartDate: "2026-10-01",
              fromDate: "2026-10-01",
              toDate: null,
              ...over,
            },
          ],
        },
      });
    expect(run(broken({ patternId: "nope" }))).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_PATTERN",
    });
    expect(run(broken({ cycleStartDate: null }))).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_PATTERN",
    });
    const shortPattern = guardInput({
      workDate: "2026-10-01",
      shifts: {
        ...baseInput().shifts,
        patterns: [{ id: "p-24-48", cycleLengthDays: 3, days: ["t-24h", null] }],
        assignments: guardInput().shifts.assignments,
      },
    });
    expect(run(shortPattern)).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_PATTERN",
    });
    const unknownTemplate = guardInput({
      workDate: "2026-10-01",
      shifts: {
        ...baseInput().shifts,
        templates: [],
        assignments: guardInput().shifts.assignments,
      },
    });
    expect(run(unknownTemplate)).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_TEMPLATE",
    });
  });

  it("a temporary location changes where the guard is expected, not when", () => {
    const temp = [{ locationId: NAIMAN, fromDate: "2026-10-01", toDate: "2026-10-02" }];
    const e = expectDuty(run(guardInput({ workDate: "2026-10-01", tempAssignments: temp })));
    expect(e.locationId).toBe(NAIMAN);
    expect(iso(e.start)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("a shift employee is not expected after leaving", () => {
    expect(
      run(
        guardInput({
          workDate: "2026-10-07",
          employee: {
            ...baseInput().employee,
            scheduleMode: "SHIFT",
            status: "DISABLED",
            endDate: "2026-10-05",
          },
        }),
      ),
    ).toEqual({ expected: false, reason: "INACTIVE" });
  });
});

describe("getExpectation — shift overrides (PRD 23.1)", () => {
  const override = (
    workDate: string,
    kind: "ADD" | "REMOVE" | "SWAP",
    templateId: string | null,
  ) => ({ workDate, kind, templateId });

  it("REMOVE takes a planned shift away", () => {
    const input = guardInput({
      workDate: "2026-10-01",
      shifts: { ...guardInput().shifts, overrides: [override("2026-10-01", "REMOVE", null)] },
    });
    expect(run(input)).toEqual({ expected: false, reason: "SHIFT_OFF" });
  });

  it("ADD creates a shift on an off day", () => {
    const input = guardInput({
      workDate: "2026-10-02",
      shifts: { ...guardInput().shifts, overrides: [override("2026-10-02", "ADD", "t-night")] },
    });
    const e = expectDuty(run(input));
    expect(e.shiftTemplateId).toBe("t-night");
    expect(iso(e.start)).toBe("2026-10-02T12:00:00.000Z");
  });

  it("SWAP replaces the planned template", () => {
    const input = guardInput({
      workDate: "2026-10-01",
      shifts: { ...guardInput().shifts, overrides: [override("2026-10-01", "SWAP", "t-night")] },
    });
    expect(expectDuty(run(input)).shiftTemplateId).toBe("t-night");
    expect(guard24h.id).not.toBe("t-night");
  });

  it("an override is HR's explicit decision and wins over a holiday", () => {
    const holidays = [
      {
        fromDate: "2026-10-02",
        toDate: "2026-10-02",
        repeatsYearly: false,
        appliesToAll: true,
        locationIds: [],
      },
    ];
    const input = guardInput({
      workDate: "2026-10-02",
      holidays,
      shifts: { ...guardInput().shifts, overrides: [override("2026-10-02", "ADD", "t-day")] },
    });
    expect(run(input).expected).toBe(true);
  });

  it("an extra shift can also be added for an employee on the standard schedule", () => {
    const input = baseInput({
      workDate: SAT,
      shifts: { ...baseInput().shifts, overrides: [override(SAT, "ADD", "t-day")] },
    });
    const e = expectDuty(run(input));
    expect(e).toMatchObject({ source: "SHIFT", shiftTemplateId: "t-day" });
    expect(
      run(
        baseInput({
          shifts: { ...baseInput().shifts, overrides: [override(MON, "REMOVE", null)] },
        }),
      ),
    ).toEqual({ expected: false, reason: "SHIFT_OFF" });
  });

  it("an override that names an unknown template is reported", () => {
    const input = guardInput({
      workDate: "2026-10-02",
      shifts: { ...guardInput().shifts, overrides: [override("2026-10-02", "ADD", "ghost")] },
    });
    expect(run(input)).toEqual({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_TEMPLATE",
    });
  });

  it("an override for another date has no effect", () => {
    const input = guardInput({
      workDate: "2026-10-01",
      shifts: { ...guardInput().shifts, overrides: [override("2026-10-09", "REMOVE", null)] },
    });
    expect(run(input).expected).toBe(true);
  });
});

describe("getExpectation — purity", () => {
  it("does not modify its input and returns the same answer every time", () => {
    const input = guardInput({ workDate: "2026-10-04" });
    const snapshot = JSON.stringify(input);
    const first = run(input);
    const second = run(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(first).toEqual(second);
  });
});
