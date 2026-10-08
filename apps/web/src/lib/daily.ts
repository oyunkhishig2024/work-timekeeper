import { api } from "./api";
import { isIsoDate, type Status } from "./attendance";

export type DailyFilterStatus = Status | "EXPECTED" | "INACTIVE";

export interface DailyItem {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  rank: string | null;
  position: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  primaryLocationName: string | null;
  /** Working at another branch than the primary one for this date (PRD 12.1). */
  temporary: boolean;
  status: Status | "WORKED_OFF_DAY" | "NOT_CONFIGURED";
  arrivalAt: string | null;
  /** The last time the phone left the duty place after arriving (LEFT); INSIDE while there; UNKNOWN when it never reported leaving. */
  departureAt: string | null;
  departureState: "LEFT" | "INSIDE" | "UNKNOWN" | null;
  lateMinutes: number;
  reasonName: string | null;
  reasonNote: string | null;
  reasonAssignmentId: string | null;
  expectedStart: string | null;
  source: "AUTO" | "CORRECTED";
  systemStatus: string | null;
  correctionId: string | null;
  flaggedEvents: number;
  lastSeenAt: string | null;
  hasDevice: boolean;
  locationInactive: boolean;
}

export interface DailyResponse {
  total: number;
  counts: Record<DailyFilterStatus, number>;
  items: DailyItem[];
}

export interface Option {
  id: string;
  name: string;
}

export interface Reason extends Option {
  active: boolean;
  requiresDescription: boolean;
}

/** The daily screen's filters, kept in the URL. `status` null = «Бүгд» (everyone expected). */
export interface DailyState {
  date: string | null;
  status: DailyFilterStatus | null;
  locationId: string | null;
  departmentId: string | null;
  q: string;
}

const STATUSES: DailyFilterStatus[] = [
  "ON_TIME",
  "LATE",
  "EXCUSED",
  "NO_SHOW",
  "PENDING",
  "INACTIVE",
];

export function parseDailyState(params: { get(name: string): string | null }): DailyState {
  const date = params.get("date");
  const status = params.get("status") as DailyFilterStatus | null;
  const id = (name: string) => {
    const v = params.get(name);
    return v && /^[0-9a-f-]{36}$/iu.test(v) ? v : null;
  };
  return {
    date: isIsoDate(date) ? date : null,
    status: status && STATUSES.includes(status) ? status : null,
    locationId: id("location"),
    departmentId: id("department"),
    q: (params.get("q") ?? "").slice(0, 100),
  };
}

export function dailyHref(s: Partial<DailyState>): string {
  const q = new URLSearchParams();
  if (s.date) q.set("date", s.date);
  if (s.status) q.set("status", s.status);
  if (s.locationId) q.set("location", s.locationId);
  if (s.departmentId) q.set("department", s.departmentId);
  if (s.q?.trim()) q.set("q", s.q.trim());
  const text = q.toString();
  return text ? `/daily?${text}` : "/daily";
}

export function dailyQuery(s: { date: string } & Omit<Partial<DailyState>, "date">): string {
  const q = new URLSearchParams({ date: s.date, status: s.status ?? "EXPECTED", limit: "500" });
  if (s.locationId) q.set("locationId", s.locationId);
  if (s.departmentId) q.set("departmentId", s.departmentId);
  if (s.q?.trim()) q.set("q", s.q.trim());
  return q.toString();
}

export const fetchDailyList = (s: Parameters<typeof dailyQuery>[0]) =>
  api<DailyResponse>(`/v1/attendance/daily?${dailyQuery(s)}`);
export const fetchLocations = () => api<Option[]>("/v1/locations?active=true");
export const fetchDepartments = () => api<Option[]>("/v1/departments?active=true");
export const fetchReasons = () => api<Reason[]>("/v1/reasons?active=true");

export const FILTER_LABEL: Record<DailyFilterStatus, string> = {
  EXPECTED: "Бүгд",
  ON_TIME: "Цагтаа",
  LATE: "Хоцорсон",
  EXCUSED: "Шалтгаантай",
  NO_SHOW: "Ирээгүй",
  PENDING: "Цаг болоогүй",
  INACTIVE: "Байршил идэвхгүй",
};

export const CORRECTION_REASONS: Array<[string, string]> = [
  ["PHONE_DEAD_LOST", "Утас цэнэггүй / алдагдсан"],
  ["GPS_FAULT", "GPS-ийн асуудал"],
  ["APP_ISSUE", "Аппын асуудал"],
  ["ANOMALY_REVIEW", "Сэжигтэй event-ийн хяналт"],
  ["DATA_ENTRY_ERROR", "Бүртгэлийн алдаа"],
  ["OTHER", "Бусад"],
];

/** A reason that must be explained in words («Бусад») cannot be saved with an empty text. */
export function reasonFormProblem(reason: Reason | undefined, description: string): string | null {
  if (!reason) return "Шалтгаанаа сонгоно уу.";
  if (reason.requiresDescription && description.trim().length < 3)
    return "Энэ шалтгаанд тайлбар бичих шаардлагатай.";
  return null;
}

/** What the correction form may send; mirrors what the API accepts (PRD 6.9). */
export function correctionFormProblem(input: {
  status: "ON_TIME" | "LATE" | "NO_SHOW";
  arrival: string;
  reasonCode: string;
  note: string;
}): string | null {
  if (input.status === "NO_SHOW" && input.arrival) return "«Ирээгүй» төлөвт ирсэн цаг оруулахгүй.";
  if (input.reasonCode === "OTHER" && input.note.trim().length < 3)
    return "«Бусад» үед тайлбар бичнэ үү.";
  return null;
}

/** The most employees one reason assignment may cover (the API limit). */
export const MAX_BULK_ASSIGN = 500;

/** A reason can be given to someone who is expected that day and has none yet (PRD 11). */
export function isReasonAssignable(r: Pick<DailyItem, "status" | "reasonName">): boolean {
  return r.status !== "WORKED_OFF_DAY" && r.status !== "NOT_CONFIGURED" && !r.reasonName;
}

/** Names of the selected employees that already have a reason in the period, from a REASON_OVERLAP problem. */
export function overlapNames(
  extra: unknown,
  rows: Array<Pick<DailyItem, "employeeId" | "fullName">>,
): string[] {
  const conflicts = (extra as { conflicts?: Array<{ employeeId?: string }> } | null)?.conflicts;
  if (!Array.isArray(conflicts)) return [];
  const ids = new Set(conflicts.map((c) => c.employeeId));
  return rows.filter((r) => ids.has(r.employeeId)).map((r) => r.fullName);
}

/** What the «Гарсан цаг» column shows: the time, «Байгаа», «Тодорхойгүй» (the phone never reported leaving), or nothing. */
export function departureText(
  r: Pick<DailyItem, "departureAt" | "departureState">,
  format: (iso: string | null) => string | null,
): string {
  if (r.departureState === "LEFT") return format(r.departureAt) ?? "—";
  if (r.departureState === "INSIDE") return "Байгаа";
  if (r.departureState === "UNKNOWN") return "Тодорхойгүй";
  return "—";
}

/** What the personal-hours form may send; mirrors what the API accepts (PRD 14.3). */
export function personalHoursProblem(f: {
  fromDate: string;
  toDate: string;
  startTime: string;
  endTime: string;
}): string | null {
  if (!isIsoDate(f.fromDate) || !isIsoDate(f.toDate)) return "Огноогоо оруулна уу.";
  if (f.toDate < f.fromDate) return "Дуусах огноо эхлэх огнооноос өмнө байж болохгүй.";
  if ((Date.parse(f.toDate) - Date.parse(f.fromDate)) / 86_400_000 > 30) {
    return "Нэг удаад дээд тал нь 31 хоногийн цаг тогтооно.";
  }
  if (!/^\d\d:\d\d$/.test(f.startTime) || !/^\d\d:\d\d$/.test(f.endTime)) {
    return "Эхлэх, дуусах цагаа оруулна уу.";
  }
  if (f.endTime <= f.startTime) return "Дуусах цаг эхлэх цагаас хойш байх ёстой.";
  return null;
}
