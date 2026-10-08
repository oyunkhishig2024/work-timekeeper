import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { isValidIsoDate } from "../common/dates";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { ApiError } from "../common/api-error";
import { ExportsService, type ReportName } from "./exports.service";

const id = z.string().uuid();
const isoDate = z.string().refine(isValidIsoDate, "Use a real date as YYYY-MM-DD");
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const format = z.enum(["xlsx", "csv", "pdf"]).default("xlsx");
const period = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.to >= v.from, "to is before from");

const SCHEMAS: Record<ReportName, z.ZodTypeAny> = {
  "reason-report": z
    .object({
      format,
      from: isoDate,
      to: isoDate,
      locationId: id.optional(),
      departmentId: id.optional(),
    })
    .refine((v) => v.to >= v.from, "to is before from")
    .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, "At most 367 days"),
  "reason-assignments": z.object({
    format,
    employeeId: id.optional(),
    reasonId: id.optional(),
    departmentId: id.optional(),
    locationId: id.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    activeOn: isoDate.optional(),
  }),
  employees: z.object({
    format,
    q: z.string().trim().max(100).optional(),
    status: z.enum(["ACTIVE", "DISABLED", "ARCHIVED", "ALL"]).default("ACTIVE"),
    departmentId: id.optional(),
    locationId: id.optional(),
    scheduleMode: z.enum(["STANDARD", "SHIFT"]).optional(),
    manualAttendance: bool.optional(),
    hasDevice: bool.optional(),
    consentStatus: z.enum(["NOT_REQUESTED", "PRINTED", "SIGNED", "WITHDRAWN"]).optional(),
    rankId: id.optional(),
    positionId: id.optional(),
  }),
  holidays: z.object({
    format,
    from: isoDate.optional(),
    to: isoDate.optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    locationId: id.optional(),
  }),
  "shift-assignments": z.object({
    format,
    employeeId: id.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  }),
  "shift-roster": z
    .object({
      format,
      ...period.innerType().shape,
      departmentId: id.optional(),
      locationId: id.optional(),
      employeeId: id.optional(),
      scheduleMode: z.enum(["STANDARD", "SHIFT"]).optional(),
    })
    .refine((v) => v.to >= v.from, "to is before from"),
};

/**
 * `GET /exports/:report?format=xlsx|csv|pdf&<the same filters as the screen>` — HR and Org Admin (a Manager only when
 * the Org Admin allows it, see ExportsService). Reports: reason-report, reason-assignments, employees, holidays,
 * shift-roster, shift-assignments.
 */
@Controller("exports")
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":report")
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param("report") report: string,
    @Query() query: unknown,
    @Meta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    const schema = SCHEMAS[report as ReportName];
    if (!schema || !Object.hasOwn(SCHEMAS, report)) {
      throw new ApiError(404, "REPORT_NOT_FOUND", "Unknown report.", {
        reports: Object.keys(SCHEMAS),
      });
    }
    const { format: fmt, ...filters } = schema.parse(query) as {
      format: "xlsx" | "csv" | "pdf";
    } & Record<string, unknown>;
    const file = await this.exports.export(auth, report as ReportName, fmt, filters, meta);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(file.body);
  }
}
