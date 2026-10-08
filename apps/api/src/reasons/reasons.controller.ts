import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { ReasonsService } from "./reasons.service";

const id = z.string().uuid();
const isoDate = z.string().refine(isValidIsoDate, "Use a real date as YYYY-MM-DD");
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const name = z.string().trim().min(1).max(120);
const sortOrder = z.number().int().min(1).max(10000);

const createReason = z.object({ name, sortOrder: sortOrder.optional() }).strict();
const updateReason = z
  .object({
    name: name.optional(),
    sortOrder: sortOrder.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
const activeFilter = z.object({ active: bool.optional() });

const assignSchema = z
  .object({
    employeeIds: z.array(id).min(1).max(500),
    reasonId: id,
    fromDate: isoDate,
    toDate: isoDate.nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => !v.toDate || v.toDate >= v.fromDate, "toDate is before fromDate")
  .refine((v) => new Set(v.employeeIds).size === v.employeeIds.length, "An employee appears twice");
const endSchema = z.object({ endDate: isoDate }).strict();
const listSchema = z.object({
  employeeId: id.optional(),
  reasonId: id.optional(),
  departmentId: id.optional(),
  locationId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  activeOn: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const reportSchema = z
  .object({ from: isoDate, to: isoDate, locationId: id.optional(), departmentId: id.optional() })
  .refine((v) => v.to >= v.from, "to is before from")
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, "At most 367 days");

/** The list of reasons is configuration for the Org Admin; reading is open to Manager too. */
@Controller("reasons")
export class ReasonsController {
  constructor(private readonly reasons: ReasonsService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.reasons.list(auth, activeFilter.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":reasonId")
  get(@CurrentAuth() auth: AuthContext, @Param("reasonId") reasonId: string) {
    return this.reasons.get(auth, id.parse(reasonId));
  }

  @Roles("ORG_ADMIN")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.reasons.create(auth, createReason.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch(":reasonId")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("reasonId") reasonId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.reasons.update(auth, id.parse(reasonId), updateReason.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Delete(":reasonId")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("reasonId") reasonId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.reasons.removeReason(auth, id.parse(reasonId), meta);
  }
}

/** Assigning reasons is HR work; Managers read inside their data scope. */
@Controller()
export class ReasonAssignmentsController {
  constructor(private readonly reasons: ReasonsService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("reason-assignments")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.reasons.listAssignments(auth, listSchema.parse(query));
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("reason-assignments")
  assign(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.reasons.assign(auth, assignSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("reason-assignments/:assignmentId/end")
  @HttpCode(200)
  end(
    @CurrentAuth() auth: AuthContext,
    @Param("assignmentId") assignmentId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.reasons.end(auth, id.parse(assignmentId), endSchema.parse(body).endDate, meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Delete("reason-assignments/:assignmentId")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("assignmentId") assignmentId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.reasons.removeAssignment(auth, id.parse(assignmentId), meta);
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("reason-report")
  report(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.reasons.report(auth, reportSchema.parse(query));
  }
}
