import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext } from "../auth/auth.types";
import { CurrentAuth, Roles } from "../auth/decorators";
import { AttendanceService } from "./attendance.service";

const id = z.string().uuid();
const isoDate = z.string().refine(isValidIsoDate, "Use a real date as YYYY-MM-DD");
const STATUSES = [
  "ON_TIME",
  "LATE",
  "EXCUSED",
  "NO_SHOW",
  "PENDING",
  "WORKED_OFF_DAY",
  "NOT_CONFIGURED",
] as const;

const eventSchema = z
  .object({
    clientEventId: z.string().min(8).max(100),
    type: z.enum(["ENTER", "EXIT"]),
    locationId: id,
    ageMs: z
      .number()
      .min(0)
      .max(30 * 86_400_000),
    deviceTime: z.string().datetime({ offset: true }).optional(),
    accuracyM: z.number().min(0).max(100_000).optional(),
  })
  .strict();
const ingestSchema = z.object({ events: z.array(eventSchema).min(1).max(200) }).strict();

const dailyQuery = z.object({
  date: isoDate,
  status: z.enum(STATUSES).optional(),
  locationId: id.optional(),
  departmentId: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const recomputeSchema = z
  .object({ from: isoDate, to: isoDate, employeeId: id.optional() })
  .strict();
const rangeQuery = z.object({ from: isoDate, to: isoDate });

/** The employee's phone reports geofence transitions (PRD 6.7, 6.8). */
@Controller()
export class DeviceEventsController {
  constructor(private readonly attendance: AttendanceService) {}

  @Roles("EMPLOYEE")
  @Post("events")
  @HttpCode(200)
  ingest(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.attendance.ingest(auth, ingestSchema.parse(body).events);
  }

  @Roles("EMPLOYEE")
  @Post("heartbeat")
  @HttpCode(200)
  heartbeat(@CurrentAuth() auth: AuthContext) {
    return this.attendance.heartbeat(auth);
  }

  @Roles("EMPLOYEE")
  @Get("me/attendance")
  mine(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    const q = rangeQuery.parse(query);
    return this.attendance.mine(auth, q.from, q.to);
  }
}

/** Daily attendance and dashboard numbers, limited to the caller's data scope (PRD 4, 7, 8). */
@Controller("attendance")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("daily")
  daily(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.attendance.daily(auth, dailyQuery.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("summary")
  summary(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.attendance.summary(auth, z.object({ date: isoDate }).parse(query).date);
  }

  /** Rebuilds the derived results, for example after holidays, shifts or reasons were corrected. */
  @Roles("ORG_ADMIN", "HR")
  @Post("recompute")
  @HttpCode(200)
  recompute(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const b = recomputeSchema.parse(body);
    return this.attendance.recomputeRange(auth, b.from, b.to, b.employeeId);
  }
}
