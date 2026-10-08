import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { HolidaysService } from "./holidays.service";
import { ShiftsService, type TemplateInput } from "./shifts.service";
import { WorkingWeekService } from "./working-week.service";

const id = z.string().uuid();
const isoDate = z.string().refine(isValidIsoDate, "Use a real date as YYYY-MM-DD");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Use HH:MM (24 h)");
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const nonEmpty = (v: object) => Object.keys(v).length > 0;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const dayMs = 86_400_000;

// ---------------------------------------------------------------------------------------------- working week

const weekDay = z
  .object({
    weekday: z.number().int().min(1).max(7),
    working: z.boolean(),
    start: time.nullable().optional(),
    end: time.nullable().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.working) {
      if (!d.start || !d.end) {
        ctx.addIssue({ code: "custom", message: "A working day needs start and end" });
      } else if (minutes(d.start) >= minutes(d.end)) {
        ctx.addIssue({ code: "custom", message: "start must be before end" });
      }
    } else if (d.start || d.end) {
      ctx.addIssue({ code: "custom", message: "An off day has no start or end" });
    }
  });
const putWeekSchema = z
  .object({
    locationId: id.nullable().optional(),
    effectiveFrom: isoDate.optional(),
    days: z.array(weekDay).length(7),
  })
  .strict()
  .refine(
    (v) => new Set(v.days.map((d) => d.weekday)).size === 7,
    "Give each weekday 1–7 exactly once",
  );
const inheritSchema = z.object({ locationId: id, effectiveFrom: isoDate.optional() }).strict();
const weekQuery = z.object({ locationId: id.optional(), asOf: isoDate.optional() });
const versionsQuery = z.object({ locationId: id.optional() });

const exceptionSchema = z
  .object({
    date: isoDate,
    working: z.boolean(),
    start: time.nullable().optional(),
    end: time.nullable().optional(),
    locationId: id.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (!d.working && (d.start || d.end)) {
      ctx.addIssue({ code: "custom", message: "A day off has no start or end" });
    }
    if (d.working && !!d.start !== !!d.end) {
      ctx.addIssue({ code: "custom", message: "Give both start and end, or neither" });
    }
    if (d.working && d.start && d.end && minutes(d.start) >= minutes(d.end)) {
      ctx.addIssue({ code: "custom", message: "start must be before end" });
    }
  });
const exceptionQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  locationId: id.optional(),
});

/** Reading is open to Manager too; changing the working week is for the Org Admin (PRD 14). */
@Controller()
export class WorkingWeekController {
  constructor(private readonly week: WorkingWeekService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("working-week")
  get(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.week.get(auth, weekQuery.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("working-week/versions")
  versions(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.week.versions(auth, versionsQuery.parse(query).locationId ?? null);
  }

  @Roles("ORG_ADMIN")
  @Put("working-week")
  put(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.week.put(auth, putWeekSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Post("working-week/inherit")
  @HttpCode(200)
  inherit(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.week.inherit(auth, inheritSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("working-day-exceptions")
  listExceptions(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.week.listExceptions(auth, exceptionQuery.parse(query));
  }

  @Roles("ORG_ADMIN")
  @Post("working-day-exceptions")
  createException(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.week.createException(auth, exceptionSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Delete("working-day-exceptions/:exceptionId")
  @HttpCode(204)
  async deleteException(
    @CurrentAuth() auth: AuthContext,
    @Param("exceptionId") exceptionId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.week.deleteException(auth, id.parse(exceptionId), meta);
  }
}

// ---------------------------------------------------------------------------------------------- holidays

const kind = z.enum(["PUBLIC_HOLIDAY", "COMPANY_DAY_OFF", "TRANSFERRED_DAY_OFF"]);
const holidayFields = {
  name: z.string().trim().min(1).max(160),
  fromDate: isoDate,
  toDate: isoDate,
  kind: kind.default("PUBLIC_HOLIDAY"),
  repeatsYearly: z.boolean().default(false),
  appliesToAll: z.boolean().default(true),
  locationIds: z.array(id).max(200).default([]),
};
const holidayChecks = (
  h: { fromDate?: string; toDate?: string; appliesToAll?: boolean; locationIds?: string[] },
  ctx: z.RefinementCtx,
) => {
  if (h.fromDate && h.toDate) {
    const days = (Date.parse(h.toDate) - Date.parse(h.fromDate)) / dayMs;
    if (days < 0) ctx.addIssue({ code: "custom", message: "toDate is before fromDate" });
    if (days > 30) ctx.addIssue({ code: "custom", message: "A holiday spans at most 31 days" });
  }
  if (h.appliesToAll === true && (h.locationIds?.length ?? 0) > 0) {
    ctx.addIssue({ code: "custom", message: "Give locationIds only when appliesToAll is false" });
  }
  if (h.appliesToAll === false && (h.locationIds?.length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Give at least one location when appliesToAll is false",
    });
  }
};
const createHoliday = z
  .object({ ...holidayFields, confirmRecompute: z.boolean().optional() })
  .strict()
  .superRefine(holidayChecks);
const updateHoliday = z
  .object({
    name: holidayFields.name.optional(),
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
    kind: kind.optional(),
    repeatsYearly: z.boolean().optional(),
    appliesToAll: z.boolean().optional(),
    locationIds: z.array(id).max(200).optional(),
    confirmRecompute: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      nonEmpty(Object.fromEntries(Object.entries(v).filter(([k]) => k !== "confirmRecompute"))),
    "Nothing to update",
  )
  .superRefine(holidayChecks);
const holidayQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  locationId: id.optional(),
});
const deleteHolidayQuery = z.object({ confirmRecompute: bool.optional() });
const copyYear = z
  .object({
    fromYear: z.number().int().min(2000).max(2100),
    toYear: z.number().int().min(2000).max(2100),
    confirmRecompute: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.fromYear !== v.toYear, "Choose two different years");

@Controller("holidays")
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.holidays.list(auth, holidayQuery.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":holidayId")
  get(@CurrentAuth() auth: AuthContext, @Param("holidayId") holidayId: string) {
    return this.holidays.get(auth, id.parse(holidayId));
  }

  @Roles("ORG_ADMIN")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.holidays.create(auth, createHoliday.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Post("copy-year")
  @HttpCode(200)
  copyYear(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.holidays.copyYear(auth, copyYear.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch(":holidayId")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("holidayId") holidayId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.holidays.update(auth, id.parse(holidayId), updateHoliday.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Delete(":holidayId")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("holidayId") holidayId: string,
    @Query() query: unknown,
    @Meta() meta: RequestMeta,
  ) {
    await this.holidays.remove(
      auth,
      id.parse(holidayId),
      deleteHolidayQuery.parse(query).confirmRecompute,
      meta,
    );
  }
}

// ---------------------------------------------------------------------------------------------- shifts

const templateTiming = {
  graceMinutes: z.number().int().min(0).max(240).optional(),
  cutoffMinutes: z.number().int().min(0).max(1440).optional(),
  earlyWindowMinutes: z.number().int().min(0).max(720).optional(),
  observesHolidays: z.boolean().optional(),
};
const name = z.string().trim().min(1).max(120);
/** End time 20:00 for a shift starting 08:00 = 12 h; an end at or before the start is the next day; equal = 24 h. */
const durationFromEnd = (start: string, end: string) => {
  const d = minutes(end) - minutes(start);
  return d > 0 ? d : d + 1440;
};
const createTemplate = z
  .object({
    name,
    startTime: time,
    durationMinutes: z.number().int().min(1).max(1440).optional(),
    endTime: time.optional(),
    ...templateTiming,
  })
  .strict()
  .refine(
    (v) => (v.durationMinutes === undefined) !== (v.endTime === undefined),
    "Give either durationMinutes or endTime",
  )
  .transform(({ endTime, ...v }): TemplateInput => ({
    ...v,
    durationMinutes: v.durationMinutes ?? durationFromEnd(v.startTime, endTime!),
  }));
const updateTemplate = z
  .object({
    name: name.optional(),
    active: z.boolean().optional(),
    startTime: time.optional(),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
    endTime: time.optional(),
    ...templateTiming,
  })
  .strict()
  .refine(nonEmpty, "Nothing to update")
  .refine(
    (v) => !(v.endTime && v.durationMinutes !== undefined),
    "Give either durationMinutes or endTime",
  )
  .refine((v) => !v.endTime || v.startTime, "endTime needs startTime in the same request")
  .transform(({ endTime, ...v }) => ({
    ...v,
    ...(endTime && v.startTime ? { durationMinutes: durationFromEnd(v.startTime, endTime) } : {}),
  }));
const supersedeTemplate = z
  .object({
    name: name.optional(),
    startTime: time.optional(),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
    endTime: time.optional(),
    ...templateTiming,
  })
  .strict()
  .refine(
    (v) => !(v.endTime && v.durationMinutes !== undefined),
    "Give either durationMinutes or endTime",
  )
  .refine((v) => !v.endTime || v.startTime, "endTime needs startTime in the same request")
  .transform(({ endTime, ...v }) => ({
    ...v,
    ...(endTime && v.startTime ? { durationMinutes: durationFromEnd(v.startTime, endTime) } : {}),
  }));
const activeFilter = z.object({ active: bool.optional() });
const createPattern = z.object({ name, days: z.array(id.nullable()).min(1).max(366) }).strict();
const updatePattern = z
  .object({ name: name.optional(), active: z.boolean().optional() })
  .strict()
  .refine(nonEmpty, "Nothing to update");

/** Reading is open to Manager; templates and patterns are configuration for the Org Admin (PRD 23). */
@Controller()
export class ShiftConfigController {
  constructor(private readonly shifts: ShiftsService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("shift-templates")
  listTemplates(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.shifts.listTemplates(auth, activeFilter.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("shift-templates/:templateId")
  getTemplate(@CurrentAuth() auth: AuthContext, @Param("templateId") templateId: string) {
    return this.shifts.getTemplate(auth, id.parse(templateId));
  }

  @Roles("ORG_ADMIN")
  @Post("shift-templates")
  createTemplate(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.shifts.createTemplate(auth, createTemplate.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch("shift-templates/:templateId")
  updateTemplate(
    @CurrentAuth() auth: AuthContext,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.shifts.updateTemplate(auth, id.parse(templateId), updateTemplate.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Post("shift-templates/:templateId/new-version")
  supersede(
    @CurrentAuth() auth: AuthContext,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.shifts.supersedeTemplate(
      auth,
      id.parse(templateId),
      supersedeTemplate.parse(body ?? {}),
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("shift-patterns")
  listPatterns(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.shifts.listPatterns(auth, activeFilter.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("shift-patterns/:patternId")
  getPattern(@CurrentAuth() auth: AuthContext, @Param("patternId") patternId: string) {
    return this.shifts.getPattern(auth, id.parse(patternId));
  }

  @Roles("ORG_ADMIN")
  @Post("shift-patterns")
  createPattern(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.shifts.createPattern(auth, createPattern.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch("shift-patterns/:patternId")
  updatePattern(
    @CurrentAuth() auth: AuthContext,
    @Param("patternId") patternId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.shifts.updatePattern(auth, id.parse(patternId), updatePattern.parse(body), meta);
  }
}

const assignSchema = z
  .object({
    items: z
      .array(z.object({ employeeId: id, cycleStartDate: isoDate.optional() }).strict())
      .min(1)
      .max(500),
    patternId: id.optional(),
    templateId: id.optional(),
    cycleStartDate: isoDate.optional(),
    fromDate: isoDate,
    toDate: isoDate.nullable().optional(),
  })
  .strict()
  .refine(
    (v) => (v.patternId === undefined) !== (v.templateId === undefined),
    "Give either patternId or templateId",
  )
  .refine(
    (v) => !v.templateId || (!v.cycleStartDate && v.items.every((i) => !i.cycleStartDate)),
    "cycleStartDate is only for patterns",
  )
  .refine((v) => !v.toDate || v.toDate >= v.fromDate, "toDate is before fromDate")
  .refine(
    (v) => new Set(v.items.map((i) => i.employeeId)).size === v.items.length,
    "An employee appears twice",
  );
const endSchema = z.object({ toDate: isoDate }).strict();
const listWindow = z.object({
  employeeId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const overrideSchema = z
  .object({
    employeeId: id,
    workDate: isoDate,
    kind: z.enum(["ADD", "REMOVE", "SWAP"]),
    templateId: id.optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine(
    (v) => (v.kind === "REMOVE") === (v.templateId === undefined),
    "ADD and SWAP need a templateId; REMOVE has none",
  );

/** Rosters are HR work; Managers can read the part of the roster inside their data scope. */
@Controller()
export class ShiftRosterController {
  constructor(private readonly shifts: ShiftsService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("shift-assignments")
  listAssignments(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.shifts.listAssignments(auth, listWindow.parse(query));
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("shift-assignments")
  assign(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.shifts.assign(auth, assignSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("shift-assignments/:assignmentId/end")
  @HttpCode(200)
  end(
    @CurrentAuth() auth: AuthContext,
    @Param("assignmentId") assignmentId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.shifts.endAssignment(
      auth,
      id.parse(assignmentId),
      endSchema.parse(body).toDate,
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Delete("shift-assignments/:assignmentId")
  @HttpCode(204)
  async deleteAssignment(
    @CurrentAuth() auth: AuthContext,
    @Param("assignmentId") assignmentId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.shifts.deleteAssignment(auth, id.parse(assignmentId), meta);
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("shift-overrides")
  listOverrides(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.shifts.listOverrides(auth, listWindow.parse(query));
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("shift-overrides")
  createOverride(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.shifts.createOverride(auth, overrideSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Delete("shift-overrides/:overrideId")
  @HttpCode(204)
  async deleteOverride(
    @CurrentAuth() auth: AuthContext,
    @Param("overrideId") overrideId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.shifts.deleteOverride(auth, id.parse(overrideId), meta);
  }
}
