import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { EmployeesService } from "./employees.service";

const id = z.string().uuid();
const isoDate = z.string().refine(isValidIsoDate, "Use a real date as YYYY-MM-DD");
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

/** Free text (any wording an organization uses), 1–120 characters. */
const title = z.string().trim().min(1).max(120);

const fields = {
  lastName: z.string().trim().min(1).max(80),
  firstName: z.string().trim().min(1).max(80),
  departmentId: id,
  primaryLocationId: id,
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  scheduleMode: z.enum(["STANDARD", "SHIFT"]).optional(),
  manualAttendance: z.boolean().optional(),
  rank: title.optional(),
  position: title.optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z
  .object({ ...fields, rank: title.nullable().optional(), position: title.nullable().optional() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "DISABLED", "ARCHIVED", "ALL"]).default("ACTIVE"),
  departmentId: id.optional(),
  locationId: id.optional(),
  scheduleMode: z.enum(["STANDARD", "SHIFT"]).optional(),
  manualAttendance: bool.optional(),
  rank: z.string().trim().min(1).max(120).optional(),
  position: z.string().trim().min(1).max(120).optional(),
  hasDevice: bool.optional(),
  consentStatus: z.enum(["NOT_REQUESTED", "PRINTED", "SIGNED", "WITHDRAWN"]).optional(),
  sort: z
    .enum(["employeeNo", "fullName", "lastName", "firstName", "createdAt"])
    .default("employeeNo"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const assignSchema = z
  .object({
    effectiveDate: isoDate.optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
const assignRank = assignSchema.extend({ rank: title.nullable() }).strict();
const assignPosition = assignSchema.extend({ position: title.nullable() }).strict();

const disableSchema = z
  .object({ effectiveDate: isoDate.optional(), reason: z.string().trim().max(300).optional() })
  .strict();
const reactivateSchema = z
  .object({ departmentId: id, primaryLocationId: id, startDate: isoDate.optional() })
  .strict();
const archiveSchema = z.object({ force: z.boolean().optional() }).strict();
const accountSchema = z
  .object({
    // Optional: the default login name is the employee's 16-digit code.
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/u, "Only letters, digits, dot, underscore and dash")
      .optional(),
  })
  .strict();

/**
 * Employees (PRD 12). Reading: Org Admin, HR and — within their assigned scope — Manager. Changing: HR and
 * Org Admin. There is no delete: employees are disabled and later archived so history is kept.
 */
@Controller("employees")
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.employees.list(auth, listSchema.parse(query));
  }

  /** Rank / position values already in use, for the suggestion list of the text fields. */
  @Roles("ORG_ADMIN", "HR")
  @Get("job-titles/:kind")
  jobTitles(@CurrentAuth() auth: AuthContext, @Param("kind") kind: string) {
    return this.employees.jobTitleSuggestions(auth, z.enum(["rank", "position"]).parse(kind));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":employeeId")
  get(@CurrentAuth() auth: AuthContext, @Param("employeeId") employeeId: string) {
    return this.employees.get(auth, id.parse(employeeId));
  }

  @Roles("ORG_ADMIN", "HR")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.employees.create(auth, createSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Patch(":employeeId")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.update(auth, id.parse(employeeId), updateSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":employeeId/rank-history")
  rankHistory(@CurrentAuth() auth: AuthContext, @Param("employeeId") employeeId: string) {
    return this.employees.jobHistory(auth, "rank", id.parse(employeeId));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":employeeId/position-history")
  positionHistory(@CurrentAuth() auth: AuthContext, @Param("employeeId") employeeId: string) {
    return this.employees.jobHistory(auth, "position", id.parse(employeeId));
  }

  /** Promotion: the open rank period ends on the effective date and a new one starts. */
  @Roles("ORG_ADMIN", "HR")
  @Put(":employeeId/rank")
  setRank(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    const { rank, ...rest } = assignRank.parse(body);
    return this.employees.assignJob(
      auth,
      "rank",
      id.parse(employeeId),
      { title: rank, ...rest },
      meta,
    );
  }

  /** Transfer / new role: independent of the rank. */
  @Roles("ORG_ADMIN", "HR")
  @Put(":employeeId/position")
  setPosition(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    const { position, ...rest } = assignPosition.parse(body);
    return this.employees.assignJob(
      auth,
      "position",
      id.parse(employeeId),
      { title: position, ...rest },
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":employeeId/disable")
  @HttpCode(200)
  disable(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.disable(
      auth,
      id.parse(employeeId),
      disableSchema.parse(body ?? {}),
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":employeeId/reactivate")
  @HttpCode(200)
  reactivate(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.reactivate(
      auth,
      id.parse(employeeId),
      reactivateSchema.parse(body),
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":employeeId/archive")
  @HttpCode(200)
  archive(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.archive(
      auth,
      id.parse(employeeId),
      archiveSchema.parse(body ?? {}),
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":employeeId/account")
  createAccount(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.employees.createAccount(
      auth,
      id.parse(employeeId),
      accountSchema.parse(body ?? {}),
      meta,
    );
  }
}
