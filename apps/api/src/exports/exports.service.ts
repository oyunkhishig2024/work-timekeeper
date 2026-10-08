import { Injectable } from "@nestjs/common";
import { ApiError, forbidden } from "../common/api-error";
import { Clock } from "../common/clock";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { DailyAttendanceService } from "../attendance/daily.service";
import { EmployeesService, type EmployeeFilter } from "../employees/employees.service";
import { ReasonsService } from "../reasons/reasons.service";
import { HolidaysService } from "../schedule/holidays.service";
import { RosterService, type RosterCell } from "../schedule/roster.service";
import { ShiftsService } from "../schedule/shifts.service";
import { CONTENT_TYPES, type Column, type ExportFormat, type Table } from "../tabular/table";
import { toCsv, toPdf, toXlsx } from "../tabular/write";

/** Larger exports need background jobs (Architecture: export jobs); until then they are refused, not truncated. */
export const MAX_EXPORT_ROWS = 20_000;

export type ReportName =
  | "reason-report"
  | "reason-assignments"
  | "employees"
  | "holidays"
  | "shift-roster"
  | "shift-assignments"
  | "daily-attendance";

export interface ExportResult {
  body: Buffer;
  contentType: string;
  fileName: string;
}

const KIND_TEXT: Record<string, string> = {
  PUBLIC_HOLIDAY: "Нийтийн баяр",
  COMPANY_DAY_OFF: "Компанийн амралт",
  TRANSFERRED_DAY_OFF: "Шилжүүлсэн амралт",
};
const STATUS_TEXT: Record<string, string> = {
  ACTIVE: "Идэвхтэй",
  DISABLED: "Идэвхгүй",
  ARCHIVED: "Архивласан",
};
const yesNo = (v: unknown) => (v ? "Тийм" : "Үгүй");
const ATTENDANCE_TEXT: Record<string, string> = {
  ON_TIME: "Цагтаа",
  LATE: "Хоцорсон",
  EXCUSED: "Шалтгаантай",
  NO_SHOW: "Ирээгүй",
  PENDING: "Цаг болоогүй",
  EARLY_LEAVE: "Эрт гарсан",
  WORKED_OFF_DAY: "Амралтын өдөр ажилласан",
  NOT_CONFIGURED: "Тохиргоо дутуу",
};
const localTime = (value: Date | string | null, timeZone: string): string =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(value))
    : "";

/**
 * Report export (PRD 20): the same data and filters as on screen, as Excel (flat, for pivoting), CSV or print-ready
 * PDF with organization, period/filters, who and when. Every export is audited (PRD 15.1). HR and Org Admin may export;
 * a Manager only when the Org Admin turned on tenant setting `manager_may_export` (default off), and then only
 * inside their data scope because the numbers come from the same scoped services as the screens.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly reasons: ReasonsService,
    private readonly employees: EmployeesService,
    private readonly holidays: HolidaysService,
    private readonly shifts: ShiftsService,
    private readonly roster: RosterService,
    private readonly daily: DailyAttendanceService,
  ) {}

  async export(
    auth: AuthContext,
    report: ReportName,
    format: ExportFormat,
    filters: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<ExportResult> {
    const context = await this.context(auth);
    const table = await this.build(auth, report, filters, context.organization);
    if (table.rows.length > MAX_EXPORT_ROWS) {
      throw new ApiError(
        422,
        "EXPORT_TOO_LARGE",
        `An export has at most ${MAX_EXPORT_ROWS} rows; narrow the filters.`,
        {
          rows: table.rows.length,
        },
      );
    }
    const now = this.clock.now();
    const body =
      format === "csv"
        ? toCsv(table)
        : format === "pdf"
          ? await toPdf(table, context.user, now)
          : await toXlsx(table, context.user, now);
    await this.db.withTenant(auth.tenantId, (tx) =>
      this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "report.exported",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "report",
        after: { report, format, filters, rows: table.rows.length },
        ...meta,
      }),
    );
    const stamp = now.toISOString().slice(0, 10);
    return { body, contentType: CONTENT_TYPES[format], fileName: `${report}_${stamp}.${format}` };
  }

  private async context(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      if (auth.role === "MANAGER") {
        const setting = await tx.query<{ value: unknown }>(
          "SELECT value FROM tenant_setting WHERE key = 'manager_may_export'",
        );
        if (setting.rows[0]?.value !== true) {
          throw forbidden(
            "Managers may not export reports. The Org Admin can allow it in the settings.",
          );
        }
      }
      const org = await tx.query<{ name: string }>("SELECT name FROM tenant WHERE id = $1", [
        auth.tenantId,
      ]);
      const user = await tx.query<{ name: string }>(
        "SELECT COALESCE(display_name, username) AS name FROM user_account WHERE id = $1",
        [auth.userId],
      );
      return { organization: org.rows[0]?.name ?? "", user: user.rows[0]?.name ?? "" };
    });
  }

  private async names(auth: AuthContext, filters: { locationId?: string; departmentId?: string }) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const location = filters.locationId
        ? (
            await tx.query<{ name: string }>("SELECT name FROM location WHERE id = $1", [
              filters.locationId,
            ])
          ).rows[0]?.name
        : undefined;
      const department = filters.departmentId
        ? (
            await tx.query<{ name: string }>("SELECT name FROM department WHERE id = $1", [
              filters.departmentId,
            ])
          ).rows[0]?.name
        : undefined;
      return [
        location ? `Салбар: ${location}` : null,
        department ? `Хэлтэс: ${department}` : null,
      ].filter((x): x is string => x !== null);
    });
  }

  private async build(
    auth: AuthContext,
    report: ReportName,
    f: Record<string, unknown>,
    org: string,
  ): Promise<Table> {
    const str = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
    switch (report) {
      case "reason-report": {
        const from = str("from")!;
        const to = str("to")!;
        const data = await this.reasons.report(auth, {
          from,
          to,
          locationId: str("locationId"),
          departmentId: str("departmentId"),
        });
        return {
          title: "Шалтгааны тайлан",
          subtitle: [org, `Хугацаа: ${from} — ${to}`, ...(await this.names(auth, f))],
          columns: [
            { key: "reasonName", header: "Шалтгаан", width: 3 },
            { key: "employees", header: "Ажилтан (давхцалгүй)", width: 1.5 },
            { key: "employeeDays", header: "Ажилтан-өдөр", width: 1.5 },
          ],
          rows: data.items,
        };
      }
      case "daily-attendance": {
        const date = str("date")!;
        const tz = await this.db.withTenant(
          auth.tenantId,
          async (tx) =>
            (
              await tx.query<{ time_zone: string }>("SELECT time_zone FROM tenant WHERE id = $1", [
                auth.tenantId,
              ])
            ).rows[0]?.time_zone ?? "Asia/Ulaanbaatar",
        );
        const data = await this.daily.daily(auth, {
          date,
          status: str("status") as "EXPECTED" | undefined,
          locationId: str("locationId"),
          departmentId: str("departmentId"),
          q: str("q"),
          limit: MAX_EXPORT_ROWS + 1,
          offset: 0,
        });
        return {
          title: "Өдрийн ирц",
          subtitle: [
            org,
            `Огноо: ${date}`,
            ...(await this.names(auth, f)),
            ...(str("status")
              ? [`Төлөв: ${ATTENDANCE_TEXT[str("status")!] ?? str("status")!}`]
              : []),
          ],
          columns: [
            { key: "employeeNo", header: "Код", width: 1 },
            { key: "fullName", header: "Овог нэр", width: 2 },
            { key: "rank", header: "Цол", width: 1 },
            { key: "position", header: "Албан тушаал", width: 2 },
            { key: "departmentName", header: "Нэгж", width: 1 },
            { key: "primaryLocationName", header: "Үндсэн салбар", width: 1 },
            { key: "locationName", header: "Ажиллах салбар", width: 1 },
            { key: "statusText", header: "Төлөв", width: 1 },
            { key: "arrival", header: "Ирсэн цаг", width: 1 },
            { key: "departure", header: "Гарсан цаг", width: 1 },
            { key: "earlyLeave", header: "Эрт гарсан (мин)", width: 1 },
            { key: "lateMinutes", header: "Хоцорсон (мин)", width: 1 },
            { key: "reason", header: "Шалтгаан", width: 2 },
            { key: "source", header: "Эх сурвалж", width: 1 },
          ],
          rows: (data.items as Array<Record<string, unknown>>).map((r) => ({
            employeeNo: String(r.employeeNo),
            fullName: String(r.fullName),
            rank: (r.rank as string | null) ?? "",
            position: (r.position as string | null) ?? "",
            departmentName: (r.departmentName as string | null) ?? "",
            primaryLocationName: (r.primaryLocationName as string | null) ?? "",
            locationName: `${(r.locationName as string | null) ?? ""}${r.temporary ? " (түр)" : ""}`,
            statusText: ATTENDANCE_TEXT[String(r.status)] ?? String(r.status),
            arrival: localTime(r.arrivalAt as Date | null, tz),
            departure:
              r.departureState === "LEFT"
                ? localTime(r.departureAt as Date | null, tz)
                : r.departureState === "INSIDE"
                  ? "Байгаа"
                  : r.departureState === "UNKNOWN"
                    ? "Тодорхойгүй"
                    : "",
            earlyLeave: Number(r.earlyLeaveMinutes) > 0 ? Number(r.earlyLeaveMinutes) : "",
            lateMinutes: r.status === "LATE" ? Number(r.lateMinutes) : "",
            reason: [r.reasonName, r.reasonNote].filter(Boolean).join(": "),
            source: r.source === "CORRECTED" ? "Засварласан" : "Автомат",
          })),
        };
      }
      case "reason-assignments": {
        const data = await this.reasons.listAssignments(auth, {
          employeeId: str("employeeId"),
          reasonId: str("reasonId"),
          departmentId: str("departmentId"),
          locationId: str("locationId"),
          from: str("from"),
          to: str("to"),
          activeOn: str("activeOn"),
          limit: MAX_EXPORT_ROWS + 1,
          offset: 0,
        });
        return {
          title: "Шалтгаан оноолтын жагсаалт",
          subtitle: [
            org,
            `Хугацаа: ${str("from") ?? "…"} — ${str("to") ?? "…"}`,
            ...(await this.names(auth, f)),
          ],
          columns: [
            { key: "employeeNo", header: "Код", width: 1 },
            { key: "employeeName", header: "Ажилтан", width: 2 },
            { key: "reasonName", header: "Шалтгаан", width: 2 },
            { key: "fromDate", header: "Эхлэх", width: 1 },
            { key: "toDate", header: "Дуусах", width: 1 },
            { key: "description", header: "Тайлбар", width: 3 },
          ],
          rows: data.items,
        };
      }
      case "employees": {
        const filter = {
          status: (str("status") ?? "ACTIVE") as EmployeeFilter["status"],
          q: str("q"),
          departmentId: str("departmentId"),
          locationId: str("locationId"),
          scheduleMode: str("scheduleMode") as EmployeeFilter["scheduleMode"],
          rank: str("rank"),
          position: str("position"),
          consentStatus: str("consentStatus") as EmployeeFilter["consentStatus"],
          manualAttendance: f.manualAttendance as boolean | undefined,
          hasDevice: f.hasDevice as boolean | undefined,
          sort: "employeeNo" as const,
          order: "asc" as const,
          limit: MAX_EXPORT_ROWS + 1,
          offset: 0,
        };
        const data = await this.employees.list(auth, filter);
        const rows = (data.items as Array<Record<string, unknown>>).map((e) => ({
          employeeNo: e.employeeNo as string,
          lastName: e.lastName as string,
          firstName: e.firstName as string,
          department: e.departmentName as string,
          location: e.locationName as string,
          rank: (e.rank as string | null) ?? null,
          position: (e.position as string | null) ?? null,
          status: STATUS_TEXT[e.status as string] ?? (e.status as string),
          schedule: e.scheduleMode === "SHIFT" ? "Ээлжийн" : "Энгийн",
          consent: (e.consentStatus as string | null) ?? "NOT_REQUESTED",
          hasDevice: yesNo(e.hasActiveDevice),
          startDate: (e.startDate as string | null) ?? null,
          endDate: (e.endDate as string | null) ?? null,
        }));
        return {
          title: "Ажилтнуудын жагсаалт",
          subtitle: [org, `Төлөв: ${filter.status}`, ...(await this.names(auth, f))],
          columns: [
            { key: "employeeNo", header: "Код", width: 1 },
            { key: "lastName", header: "Овог", width: 1.6 },
            { key: "firstName", header: "Нэр", width: 1.6 },
            { key: "department", header: "Хэлтэс", width: 1.5 },
            { key: "location", header: "Салбар", width: 1.5 },
            { key: "rank", header: "Цол", width: 1.3 },
            { key: "position", header: "Албан тушаал", width: 1.8 },
            { key: "status", header: "Төлөв", width: 1 },
            { key: "schedule", header: "Цагийн хуваарь", width: 1.2 },
            { key: "consent", header: "Зөвшөөрөл", width: 1.4 },
            { key: "hasDevice", header: "Төхөөрөмж", width: 1 },
            { key: "startDate", header: "Эхэлсэн", width: 1.1 },
            { key: "endDate", header: "Дууссан", width: 1.1 },
          ],
          rows,
        };
      }
      case "holidays": {
        const list = (await this.holidays.list(auth, {
          from: str("from"),
          to: str("to"),
          year: f.year as number | undefined,
          locationId: str("locationId"),
        })) as Array<Record<string, unknown>>;
        const locations = await this.db.withTenant(
          auth.tenantId,
          async (tx) =>
            new Map(
              (
                await tx.query<{ id: string; name: string }>("SELECT id, name FROM location")
              ).rows.map((l) => [l.id, l.name]),
            ),
        );
        return {
          title: "Баярын жагсаалт",
          subtitle: [
            org,
            f.year ? `Он: ${f.year}` : `Хугацаа: ${str("from") ?? "…"} — ${str("to") ?? "…"}`,
          ],
          columns: [
            { key: "name", header: "Нэр", width: 2.5 },
            { key: "fromDate", header: "Эхлэх", width: 1.2 },
            { key: "toDate", header: "Дуусах", width: 1.2 },
            { key: "kind", header: "Төрөл", width: 1.6 },
            { key: "appliesTo", header: "Хамрах салбар", width: 2.5 },
            { key: "repeatsYearly", header: "Жил бүр", width: 1 },
          ],
          rows: list.map((h) => ({
            name: h.name as string,
            fromDate: h.fromDate as string,
            toDate: h.toDate as string,
            kind: KIND_TEXT[h.kind as string] ?? (h.kind as string),
            appliesTo: h.appliesToAll
              ? "Бүх салбар"
              : (h.locationIds as string[]).map((id) => locations.get(id) ?? id).join(", "),
            repeatsYearly: yesNo(h.repeatsYearly),
          })),
        };
      }
      case "shift-assignments": {
        const items = (await this.shifts.listAssignments(auth, {
          employeeId: str("employeeId"),
          from: str("from"),
          to: str("to"),
          limit: MAX_EXPORT_ROWS + 1,
          offset: 0,
        })) as Array<Record<string, string | null>>;
        return {
          title: "Ээлжийн оноолт",
          subtitle: [org, `Хугацаа: ${str("from") ?? "…"} — ${str("to") ?? "…"}`],
          columns: [
            { key: "employeeNo", header: "Код", width: 1 },
            { key: "employeeName", header: "Ажилтан", width: 2 },
            { key: "shift", header: "Хэв маяг / загвар", width: 2.2 },
            { key: "cycleStartDate", header: "Мөчлөг эхлэх", width: 1.2 },
            { key: "fromDate", header: "Эхлэх", width: 1.1 },
            { key: "toDate", header: "Дуусах", width: 1.1 },
          ],
          rows: items.map((a) => ({
            employeeNo: a.employeeNo!,
            employeeName: a.employeeName!,
            shift: a.patternName ?? a.templateName ?? "",
            cycleStartDate: a.cycleStartDate ?? null,
            fromDate: a.fromDate!,
            toDate: a.toDate ?? null,
          })),
        };
      }
      case "shift-roster": {
        const from = str("from")!;
        const to = str("to")!;
        const rows: Array<Record<string, string | number | null>> = [];
        let dates: string[] = [];
        for (let offset = 0; ; offset += 500) {
          const page = await this.roster.roster(auth, {
            from,
            to,
            departmentId: str("departmentId"),
            locationId: str("locationId"),
            employeeId: str("employeeId"),
            scheduleMode: str("scheduleMode") as "STANDARD" | "SHIFT" | undefined,
            limit: 500,
            offset,
          });
          dates = page.dates;
          for (const item of page.items) {
            const row: Record<string, string | number | null> = {
              employeeNo: item.employeeNo,
              fullName: item.fullName,
            };
            item.cells.forEach((c, i) => (row[`d${i}`] = cellText(c)));
            row.conflicts = item.conflicts;
            rows.push(row);
          }
          if (offset + 500 >= page.total || rows.length > MAX_EXPORT_ROWS) break;
        }
        const columns: Column[] = [
          { key: "employeeNo", header: "Код", width: 1.2 },
          { key: "fullName", header: "Ажилтан", width: 2.4 },
          ...dates.map((d, i) => ({ key: `d${i}`, header: d.slice(5), width: 1.1 })),
          { key: "conflicts", header: "Зөрчил", width: 0.8 },
        ];
        return {
          title: "Ээлжийн календарь",
          subtitle: [
            org,
            `Хугацаа: ${from} — ${to}`,
            "Тэмдэглэгээ: цаг = ажиллана, – = амралт, Баяр, ! = шалтгаантай зөрчил, * = өдрийн өөрчлөлт",
            ...(await this.names(auth, f)),
          ],
          columns,
          rows,
        };
      }
    }
  }
}

/** Short cell text for the roster export: `08:00-20:00`, `20:00-08:00+1`, `–`, `Баяр`, with ! (reason clash) and * (override). */
function cellText(c: RosterCell): string {
  let text: string;
  if (c.expected) text = `${c.start}-${c.end}${c.endsNextDay ? "+1" : ""}`;
  else if (c.reason === "HOLIDAY") text = "Баяр";
  else if (c.reason === "NOT_CONFIGURED") text = "?";
  else if (c.reason === "INACTIVE") text = "×";
  else text = "–";
  if (c.absenceReason && !c.conflict) text += " Ш";
  if (c.conflict) text += " !";
  if (c.override) text += " *";
  return text;
}
