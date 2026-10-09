import { api } from "./api";
import { addDaysIso, isIsoDate } from "./attendance";

export type ReportKind = "short" | "overtime";
export type PeriodKind = "week" | "month";

export interface TimeReportRow {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  rank: string | null;
  position: string | null;
  departmentName: string | null;
  primaryLocationName: string | null;
  expectedDays: number;
  attendedDays: number;
  lateDays: number;
  lateMinutes: number;
  earlyLeaveDays: number;
  earlyLeaveMinutes: number;
  shortMinutes: number;
  noShowDays: number;
  overtimeDays: number;
  overtimeMinutes: number;
}

export interface TimeReport {
  kind: ReportKind;
  from: string;
  to: string;
  total: number;
  items: TimeReportRow[];
}

/** The reports screen's choices, kept in the URL (`?type=&period=&date=&location=&department=`). */
export interface ReportsState {
  kind: ReportKind;
  period: PeriodKind;
  /** Any date inside the period; null = today. */
  date: string | null;
  locationId: string | null;
  departmentId: string | null;
}

export function parseReportsState(params: { get(name: string): string | null }): ReportsState {
  const date = params.get("date");
  const id = (name: string) => {
    const v = params.get(name);
    return v && /^[0-9a-f-]{36}$/iu.test(v) ? v : null;
  };
  return {
    kind: params.get("type") === "overtime" ? "overtime" : "short",
    period: params.get("period") === "month" ? "month" : "week",
    date: isIsoDate(date) ? date : null,
    locationId: id("location"),
    departmentId: id("department"),
  };
}

export function reportsHref(s: Partial<ReportsState>): string {
  const q = new URLSearchParams();
  if (s.kind && s.kind !== "short") q.set("type", s.kind);
  if (s.period && s.period !== "week") q.set("period", s.period);
  if (s.date) q.set("date", s.date);
  if (s.locationId) q.set("location", s.locationId);
  if (s.departmentId) q.set("department", s.departmentId);
  const text = q.toString();
  return text ? `/reports?${text}` : "/reports";
}

/** The week (Monday to Sunday) or the calendar month that holds `date`. */
export function periodOf(kind: PeriodKind, date: string): { from: string; to: string } {
  if (kind === "week") {
    const monday = addDaysIso(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
    return { from: monday, to: addDaysIso(monday, 6) };
  }
  const from = `${date.slice(0, 7)}-01`;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDaysIso(next.toISOString().slice(0, 10), -1) };
}

/** A date inside the previous (`-1`) or next (`1`) week or month. */
export function shiftPeriod(kind: PeriodKind, date: string, direction: -1 | 1): string {
  if (kind === "week") return addDaysIso(date, 7 * direction);
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + direction);
  return d.toISOString().slice(0, 10);
}

/** 95 → "1:35"; nothing → "—". */
export function formatHm(minutes: number): string {
  if (!minutes) return "—";
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function timeReportQuery(
  s: Pick<ReportsState, "kind" | "locationId" | "departmentId">,
  range: { from: string; to: string },
): string {
  const q = new URLSearchParams({ kind: s.kind, from: range.from, to: range.to, limit: "500" });
  if (s.locationId) q.set("locationId", s.locationId);
  if (s.departmentId) q.set("departmentId", s.departmentId);
  return q.toString();
}

export const fetchTimeReport = (query: string) =>
  api<TimeReport>(`/v1/attendance/time-report?${query}`);

/** The export of the same report (Excel / CSV / PDF), same filters. */
export function exportPath(
  s: Pick<ReportsState, "kind" | "locationId" | "departmentId">,
  range: { from: string; to: string },
  format: "xlsx" | "csv" | "pdf",
): string {
  const q = new URLSearchParams({ format, from: range.from, to: range.to });
  if (s.locationId) q.set("locationId", s.locationId);
  if (s.departmentId) q.set("departmentId", s.departmentId);
  return `/v1/exports/${s.kind === "short" ? "short-hours" : "overtime"}?${q}`;
}
