import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { EmployeesService } from "./employees.service";

const id = z.string().uuid();
const isoDate = z.string().refine(isValidIsoDate, "Use a real date as YYYY-MM-DD");
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const fields = {
  employeeNo: z.string().trim().min(1).max(40),
  fullName: z.string().trim().min(1).max(160),
  departmentId: id,
  primaryLocationId: id,
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  scheduleMode: z.enum(["STANDARD", "SHIFT"]).optional(),
  manualAttendance: z.boolean().optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z
  .object(fields)
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
  hasDevice: bool.optional(),
  consentStatus: z.enum(["NOT_REQUESTED", "PRINTED", "SIGNED", "WITHDRAWN"]).optional(),
  sort: z.enum(["employeeNo", "fullName", "createdAt"]).default("employeeNo"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const disableSchema = z
  .object({ effectiveDate: isoDate.optional(), reason: z.string().trim().max(300).optional() })
  .strict();
const reactivateSchema = z
  .object({ departmentId: id, primaryLocationId: id, startDate: isoDate.optional() })
  .strict();
const archiveSchema = z.object({ force: z.boolean().optional() }).strict();
const accountSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/u, "Only letters, digits, dot, underscore and dash"),
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
      accountSchema.parse(body),
      meta,
    );
  }
}
