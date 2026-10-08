import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { PersonalHoursService } from "./personal-hours.service";

const id = z.string().uuid();
const isoDate = z.string().refine(isValidIsoDate, "Use a real date as YYYY-MM-DD");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const createSchema = z
  .object({
    employeeIds: z.array(id).min(1).max(500),
    fromDate: isoDate,
    toDate: isoDate,
    startTime: time,
    endTime: time,
    locationIds: z.array(id).max(6).default([]),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => v.toDate >= v.fromDate, "toDate is before fromDate")
  .refine(
    (v) => (Date.parse(v.toDate) - Date.parse(v.fromDate)) / 86_400_000 <= 30,
    "At most 31 days",
  )
  .refine((v) => v.endTime > v.startTime, "endTime must be later than startTime")
  .refine((v) => new Set(v.employeeIds).size === v.employeeIds.length, "An employee appears twice")
  .refine((v) => new Set(v.locationIds).size === v.locationIds.length, "A place appears twice");
const listSchema = z.object({
  employeeId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Personal hours are HR work; Managers read inside their data scope. */
@Controller("personal-hours")
export class PersonalHoursController {
  constructor(private readonly hours: PersonalHoursService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.hours.list(auth, listSchema.parse(query));
  }

  @Roles("ORG_ADMIN", "HR")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.hours.create(auth, createSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("id") hoursId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.hours.remove(auth, id.parse(hoursId), meta);
  }
}
