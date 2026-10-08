import { api } from "./api";

/** Statuses of one employee on one work date (PRD 6.6). PENDING = the start has not passed the cut-off yet. */
export type Status = "ON_TIME" | "LATE" | "EXCUSED" | "NO_SHOW" | "PENDING";
export type StatusFilter = Status | "EXPECTED";

export interface Figures {
  total: number;
  onTime: number;
  late: number;
  excused: number;
  noShow: number;
  pending: number;
  onTimeRate: number;
  lateRate: number;
  excusedRate: number;
  noShowRate: number;
}

export interface Bucket extends Figures {
  id: string | null;
  name: string | null;
}

export interface Summary extends Figures {
  date: string;
  workedOffDay: number;
  notConfigured: number;
  /** Days with an event still waiting for review (PRD 6.7): the counts may change. */
  flagged: number;
  /** Days that were corrected by hand (PRD 6.9). */
  corrected: number;
  byLocation: Bucket[];
  byDepartment: Bucket[];
}

export interface DailyRow {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  rank: string | null;
  position: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  status: Status | "WORKED_OFF_DAY" | "NOT_CONFIGURED";
  arrivalAt: string | null;
  lateMinutes: number;
  reasonName: string | null;
  expectedStart: string | null;
  source: "AUTO" | "CORRECTED";
  flaggedEvents: number;
}

export interface Organization {
  name: string;
  code: string;
  timeZone: string;
  /** The organization's own "today" (PRD 22.2). */
  today: string;
}

export const STATUS_LABEL: Record<Status | "EXPECTED", string> = {
  EXPECTED: "Ажиллах ёстой",
  ON_TIME: "Цагтаа",
  LATE: "Хоцорсон",
  EXCUSED: "Шалтгаантай",
  NO_SHOW: "Ирээгүй",
  PENDING: "Цаг болоогүй",
};

const WEEKDAYS = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"];

/** Calendar date arithmetic on "YYYY-MM-DD", independent of the machine's time zone. */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function weekdayMn(date: string): string {
  return WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;
}

export function formatTime(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** The explanation shown next to a person in the drill-down list (what happened that day). */
export function explain(row: DailyRow, timeZone: string): string {
  const at = formatTime(row.arrivalAt, timeZone);
  const start = formatTime(row.expectedStart, timeZone);
  switch (row.status) {
    case "ON_TIME":
      return at ? `${at}-д ирсэн` : "Цагтаа ирсэн гэж тооцсон";
    case "LATE":
      return at
        ? `${at}-д ирсэн${row.lateMinutes > 0 ? ` · ${row.lateMinutes} минут хоцорсон` : ""}`
        : "Хоцорсон гэж тооцсон";
    case "EXCUSED":
      return `${row.reasonName ?? "Шалтгаан бүртгэсэн"}${at ? ` · ${at}-д ирсэн` : ""}`;
    case "NO_SHOW":
      return start
        ? `Ирсэн бүртгэлгүй (эхлэх цаг ${start}) · шалтгаан оноогоогүй`
        : "Ирсэн бүртгэлгүй · шалтгаан оноогоогүй";
    case "PENDING":
      return start ? `Эхлэх цаг ${start}, ирэх цаг болоогүй` : "Ирэх цаг болоогүй";
    default:
      return "";
  }
}

export interface Segment {
  key: Status;
  percent: number;
}

/** Widths of the stacked bar, in percent of everyone expected; empty when nobody is expected. */
export function barSegments(f: Figures): Segment[] {
  if (f.total === 0) return [];
  const parts: Array<[Status, number]> = [
    ["ON_TIME", f.onTime],
    ["LATE", f.late],
    ["EXCUSED", f.excused],
    ["NO_SHOW", f.noShow],
    ["PENDING", f.pending],
  ];
  return parts.filter(([, n]) => n > 0).map(([key, n]) => ({ key, percent: (n / f.total) * 100 }));
}

export function countFor(f: Figures, status: StatusFilter): number {
  switch (status) {
    case "EXPECTED":
      return f.total;
    case "ON_TIME":
      return f.onTime;
    case "LATE":
      return f.late;
    case "EXCUSED":
      return f.excused;
    case "NO_SHOW":
      return f.noShow;
    case "PENDING":
      return f.pending;
  }
}

export function rateFor(f: Figures, status: StatusFilter): number | null {
  switch (status) {
    case "ON_TIME":
      return f.onTimeRate;
    case "LATE":
      return f.lateRate;
    case "EXCUSED":
      return f.excusedRate;
    case "NO_SHOW":
      return f.noShowRate;
    default:
      return null;
  }
}

/** What the dashboard shows, kept in the URL so the back button and links work. */
export interface DashboardState {
  date: string | null; // null = the organization's today
  status: StatusFilter | null; // null = the overview, otherwise the list
  locationId: string | null;
  departmentId: string | null;
  by: "location" | "department";
}

const STATUS_VALUES: StatusFilter[] = [
  "EXPECTED",
  "ON_TIME",
  "LATE",
  "EXCUSED",
  "NO_SHOW",
  "PENDING",
];

export function parseDashboardState(params: { get(name: string): string | null }): DashboardState {
  const date = params.get("date");
  const status = params.get("status") as StatusFilter | null;
  const id = (name: string) => {
    const v = params.get(name);
    return v && /^[0-9a-f-]{36}$/iu.test(v) ? v : null;
  };
  return {
    date: isIsoDate(date) ? date : null,
    status: status && STATUS_VALUES.includes(status) ? status : null,
    locationId: id("location"),
    departmentId: id("department"),
    by: params.get("by") === "department" ? "department" : "location",
  };
}

export function dashboardHref(s: Partial<DashboardState>): string {
  const q = new URLSearchParams();
  if (s.date) q.set("date", s.date);
  if (s.status) q.set("status", s.status);
  if (s.locationId) q.set("location", s.locationId);
  if (s.departmentId) q.set("department", s.departmentId);
  if (s.by === "department") q.set("by", "department");
  const text = q.toString();
  return text ? `/dashboard?${text}` : "/dashboard";
}

export const fetchOrganization = async (): Promise<Organization> =>
  (await api<{ organization: Organization }>("/v1/auth/me")).organization;

export const fetchSummary = (date: string) => api<Summary>(`/v1/attendance/summary?date=${date}`);

export function fetchDaily(s: {
  date: string;
  status: StatusFilter;
  locationId: string | null;
  departmentId: string | null;
}) {
  const q = new URLSearchParams({ date: s.date, status: s.status, limit: "500" });
  if (s.locationId) q.set("locationId", s.locationId);
  if (s.departmentId) q.set("departmentId", s.departmentId);
  return api<{ total: number; items: DailyRow[] }>(`/v1/attendance/daily?${q}`);
}
