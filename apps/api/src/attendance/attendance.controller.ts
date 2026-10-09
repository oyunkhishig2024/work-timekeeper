import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { AnomaliesService } from "./anomalies.service";
import { DeviceAlertsService } from "./device-alerts.service";
import { AttendanceService } from "./attendance.service";
import { DailyAttendanceService } from "./daily.service";
import { MobilePlanService } from "./mobile-plan.service";
import { TimeReportService } from "./time-report.service";
import { CORRECTION_REASONS, CorrectionsService } from "./corrections.service";

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
    mockLocation: z.boolean().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine((e) => (e.lat === undefined) === (e.lng === undefined), {
    message: "Send lat and lng together",
    path: ["lat"],
  });
const ingestSchema = z
  .object({
    events: z.array(eventSchema).min(1).max(200),
    /** Play Integrity / App Attest verdict for this batch, and the install key that signed it (PRD 6.7). */
    attestationToken: z.string().min(1).max(20_000).optional(),
    attestationKeyId: z.string().min(1).max(512).optional(),
  })
  .strict();

const dailyQuery = z.object({
  date: isoDate,
  /** EXPECTED = everyone expected that day (on time, late, excused, no show, still pending): the dashboard's total. */
  status: z.enum([...STATUSES, "EXPECTED", "INACTIVE", "EARLY_LEAVE"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  locationId: id.optional(),
  departmentId: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const periodFilters = {
  from: isoDate,
  to: isoDate,
  q: z.string().trim().min(1).max(100).optional(),
  locationId: id.optional(),
  departmentId: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
};
const timeReportQuery = z
  .object({ kind: z.enum(["short", "overtime"]), ...periodFilters })
  .refine((v) => v.to >= v.from, "to is before from");
const offDayQuery = z.object(periodFilters).refine((v) => v.to >= v.from, "to is before from");
const recomputeSchema = z
  .object({ from: isoDate, to: isoDate, employeeId: id.optional() })
  .strict();
const rangeQuery = z.object({ from: isoDate, to: isoDate });

/** The employee's phone reports geofence transitions (PRD 6.7, 6.8). */
@Controller()
export class DeviceEventsController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly mobilePlan: MobilePlanService,
  ) {}

  @Roles("EMPLOYEE", "HR", "MANAGER", "ORG_ADMIN")
  @Post("events")
  @HttpCode(200)
  ingest(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const b = ingestSchema.parse(body);
    return this.attendance.ingest(auth, b.events, {
      attestationToken: b.attestationToken,
      attestationKeyId: b.attestationKeyId,
    });
  }

  @Roles("EMPLOYEE", "HR", "MANAGER", "ORG_ADMIN")
  @Post("heartbeat")
  @HttpCode(200)
  heartbeat(@CurrentAuth() auth: AuthContext) {
    return this.attendance.heartbeat(auth);
  }

  /** The places the phone watches today and on the next two days (Architecture 7.3). */
  @Roles("EMPLOYEE", "HR", "MANAGER", "ORG_ADMIN")
  @Get("mobile/plan")
  plan(@CurrentAuth() auth: AuthContext) {
    return this.mobilePlan.plan(auth);
  }

  @Roles("EMPLOYEE", "HR", "MANAGER", "ORG_ADMIN")
  @Get("me/attendance")
  mine(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    const q = rangeQuery.parse(query);
    return this.attendance.mine(auth, q.from, q.to);
  }
}

/** Daily attendance and dashboard numbers, limited to the caller's data scope (PRD 4, 7, 8). */
@Controller("attendance")
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly dailyList: DailyAttendanceService,
    private readonly timeReport: TimeReportService,
  ) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("daily")
  daily(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.dailyList.daily(auth, dailyQuery.parse(query));
  }

  /** Short-hours (`kind=short`) and overtime (`kind=overtime`) per employee for a week, a month or any period (≤ 93 days). */
  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("time-report")
  timeReportList(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.timeReport.report(auth, timeReportQuery.parse(query));
  }

  /** Days people came on a holiday or a day off: arrival and departure only, nothing counted (PRD 6.1). */
  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get("off-day-work")
  offDayWork(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.timeReport.offDayWork(auth, offDayQuery.parse(query));
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

// ---------------------------------------------------------------------------------------------- corrections (PRD 6.9)

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const correctionSchema = z
  .object({
    employeeId: id,
    workDate: isoDate,
    status: z.enum(["ON_TIME", "LATE", "NO_SHOW"]),
    arrivalAt: z.string().datetime({ offset: true }).nullable().optional(),
    reasonCode: z.enum(CORRECTION_REASONS),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => v.reasonCode !== "OTHER" || (v.note ?? "").length >= 3, {
    message: "Describe the reason when you choose Other",
    path: ["note"],
  });
const revokeSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
const correctionQuery = z.object({
  from: isoDate,
  to: isoDate,
  employeeId: id.optional(),
  actorId: id.optional(),
  reasonCode: z.enum(CORRECTION_REASONS).optional(),
  locationId: id.optional(),
  includeRevoked: bool.default("false"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** HR and Org Admin correct directly, with no second approval; the safeguards are the reason, the audit trail and the report. */
@Controller("attendance/corrections")
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Roles("ORG_ADMIN", "HR")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    const b = correctionSchema.parse(body);
    return this.corrections.create(
      auth,
      { ...b, arrivalAt: b.arrivalAt ? new Date(b.arrivalAt) : null },
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":correctionId/revoke")
  @HttpCode(200)
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param("correctionId") correctionId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.corrections.revoke(
      auth,
      id.parse(correctionId),
      revokeSchema.parse(body ?? {}).note,
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.corrections.list(auth, correctionQuery.parse(query));
  }

  @Roles("ORG_ADMIN")
  @Get("report")
  report(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    const q = rangeQuery.parse(query);
    return this.corrections.report(auth, q.from, q.to);
  }
}

// ---------------------------------------------------------------------------------------------- anomaly queue (PRD 6.7)

const anomalyQuery = z.object({
  status: z
    .enum(["OPEN", "ALL", "PENDING", "CONFIRMED", "REJECTED", "RECHECK_REQUESTED"])
    .default("OPEN"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  employeeId: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const reviewSchema = z
  .object({
    decision: z.enum(["CONFIRM", "REJECT", "REQUEST_RECHECK"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.decision !== "REJECT" || (v.note ?? "").length >= 3, {
    message: "Say why the event is rejected",
    path: ["note"],
  });

@Controller("attendance/anomalies")
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  @Roles("ORG_ADMIN", "HR")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    const q = anomalyQuery.parse(query);
    return this.anomalies.list(auth, {
      ...q,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":eventId/review")
  @HttpCode(200)
  review(
    @CurrentAuth() auth: AuthContext,
    @Param("eventId") eventId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    const b = reviewSchema.parse(body);
    return this.anomalies.review(auth, id.parse(eventId), b.decision, b.note, meta);
  }
}

// ---------------------------------------------------------------------------------------------- device alerts (PRD 6.7)

const alertQuery = z.object({
  status: z.enum(["OPEN", "ALL"]).default("OPEN"),
  kind: z.enum(["ATTESTATION_UNAVAILABLE_STREAK", "DEVICE_CONFLICT"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller("device-alerts")
export class DeviceAlertsController {
  constructor(private readonly alerts: DeviceAlertsService) {}

  @Roles("ORG_ADMIN", "HR")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.alerts.list(auth, alertQuery.parse(query));
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":alertId/resolve")
  @HttpCode(200)
  resolve(
    @CurrentAuth() auth: AuthContext,
    @Param("alertId") alertId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.resolve(auth, id.parse(alertId), revokeSchema.parse(body ?? {}).note, meta);
  }
}
