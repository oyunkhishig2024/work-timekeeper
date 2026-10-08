import { api } from "./api";
import { isIsoDate } from "./attendance";

export type EmployeeStatus = "ACTIVE" | "DISABLED" | "ARCHIVED";
export type StatusFilter = EmployeeStatus | "ALL";
export type ConsentStatus = "NOT_REQUESTED" | "PRINTED" | "SIGNED" | "WITHDRAWN";

export interface EmployeeListItem {
  id: string;
  employeeNo: string;
  fullName: string;
  lastName: string;
  firstName: string;
  status: EmployeeStatus;
  departmentId: string;
  departmentName: string;
  primaryLocationId: string;
  locationName: string;
  startDate: string | null;
  endDate: string | null;
  scheduleMode: "STANDARD" | "SHIFT";
  manualAttendance: boolean;
  rank: string | null;
  position: string | null;
  consentStatus: ConsentStatus | null;
  hasActiveDevice: boolean;
}

export interface EmployeeDetail extends EmployeeListItem {
  account: { userId: string; username: string; status: string } | null;
  device: {
    id: string;
    platform: string;
    model: string | null;
    osVersion: string | null;
    registeredAt: string;
  } | null;
}

export interface DeviceRow {
  id: string;
  platform: "ANDROID" | "IOS";
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  status: "ACTIVE" | "DISABLED" | "REPLACED";
  attestationState: string;
  registeredAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface ConsentInfo {
  status: ConsentStatus;
  reconsentRequired: boolean;
  activeTextVersion: string | null;
  records: Array<{
    id: string;
    formCode: string;
    status: string;
    signedOn: string | null;
    withdrawnOn: string | null;
  }>;
}

export interface HistoryRow {
  id: string;
  rank?: string;
  position?: string;
  validFrom: string;
  validTo: string | null;
  note: string | null;
}

export interface ReplacementQr {
  id: string;
  token: string;
  qrPayload: string;
  expiresAt: string;
}

export const STATUS_LABEL: Record<StatusFilter, string> = {
  ACTIVE: "Идэвхтэй",
  DISABLED: "Идэвхгүй",
  ARCHIVED: "Архивласан",
  ALL: "Бүгд",
};

export const CONSENT_LABEL: Record<ConsentStatus, string> = {
  NOT_REQUESTED: "Хүсээгүй",
  PRINTED: "Хэвлэсэн",
  SIGNED: "Гарын үсэгтэй",
  WITHDRAWN: "Цуцалсан",
};

export const DEVICE_STATUS_LABEL: Record<DeviceRow["status"], string> = {
  ACTIVE: "Идэвхтэй",
  DISABLED: "Идэвхгүй болгосон",
  REPLACED: "Солигдсон",
};

export const DISABLE_REASON_LABEL: Record<string, string> = {
  LOST: "Алдсан",
  STOLEN: "Хулгайд алдсан",
  REPLACED: "Солигдсон",
  EMPLOYEE_DISABLED: "Ажилтан идэвхгүй болсон",
  CONSENT_WITHDRAWN: "Зөвшөөрөл цуцалсан",
  OTHER: "Бусад",
};

/** The list's filters, kept in the URL. */
export interface ListState {
  q: string;
  status: StatusFilter;
  departmentId: string | null;
  locationId: string | null;
  page: number;
}

export const PAGE_SIZE = 50;

export function parseListState(params: { get(name: string): string | null }): ListState {
  const status = params.get("status") as StatusFilter | null;
  const id = (name: string) => {
    const v = params.get(name);
    return v && /^[0-9a-f-]{36}$/iu.test(v) ? v : null;
  };
  const page = Number(params.get("page"));
  return {
    q: (params.get("q") ?? "").slice(0, 100),
    status:
      status && ["ACTIVE", "DISABLED", "ARCHIVED", "ALL"].includes(status) ? status : "ACTIVE",
    departmentId: id("department"),
    locationId: id("location"),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

export function employeesHref(s: Partial<ListState>): string {
  const q = new URLSearchParams();
  if (s.q?.trim()) q.set("q", s.q.trim());
  if (s.status && s.status !== "ACTIVE") q.set("status", s.status);
  if (s.departmentId) q.set("department", s.departmentId);
  if (s.locationId) q.set("location", s.locationId);
  if (s.page && s.page > 1) q.set("page", String(s.page));
  const text = q.toString();
  return text ? `/employees?${text}` : "/employees";
}

export function listQuery(s: ListState): string {
  const q = new URLSearchParams({
    status: s.status,
    limit: String(PAGE_SIZE),
    offset: String((s.page - 1) * PAGE_SIZE),
    sort: "employeeNo",
  });
  if (s.q.trim()) q.set("q", s.q.trim());
  if (s.departmentId) q.set("departmentId", s.departmentId);
  if (s.locationId) q.set("locationId", s.locationId);
  return q.toString();
}

export const fetchEmployees = (s: ListState) =>
  api<{ total: number; items: EmployeeListItem[] }>(`/v1/employees?${listQuery(s)}`);
export const fetchEmployee = (id: string) => api<EmployeeDetail>(`/v1/employees/${id}`);
export const fetchTitles = (kind: "rank" | "position") =>
  api<string[]>(`/v1/employees/job-titles/${kind}`);
export const fetchDevices = (id: string) => api<DeviceRow[]>(`/v1/employees/${id}/devices`);
export const fetchConsent = (id: string) => api<ConsentInfo>(`/v1/employees/${id}/consent`);
export const fetchHistory = (id: string, kind: "rank" | "position") =>
  api<HistoryRow[]>(`/v1/employees/${id}/${kind}-history`);

/** What the create / edit forms may send; mirrors the API (PRD 12). */
export interface EmployeeForm {
  lastName: string;
  firstName: string;
  departmentId: string;
  primaryLocationId: string;
  startDate: string;
  rank: string;
  position: string;
  scheduleMode: "STANDARD" | "SHIFT";
  manualAttendance: boolean;
}

export function employeeFormProblem(f: EmployeeForm): string | null {
  if (!f.lastName.trim()) return "Овгоо бичнэ үү.";
  if (!f.firstName.trim()) return "Нэрээ бичнэ үү.";
  if (!f.departmentId) return "Нэгжээ сонгоно уу.";
  if (!f.primaryLocationId) return "Үндсэн салбараа сонгоно уу.";
  if (f.startDate && !isIsoDate(f.startDate)) return "Ажилд орсон огноо буруу байна.";
  if (f.rank.length > 120 || f.position.length > 120)
    return "Цол, албан тушаал 120 тэмдэгтээс хэтэрч болохгүй.";
  return null;
}

/** The body for POST /employees: empty optional fields are left out so the server applies its defaults. */
export function createBody(f: EmployeeForm) {
  return {
    lastName: f.lastName.trim(),
    firstName: f.firstName.trim(),
    departmentId: f.departmentId,
    primaryLocationId: f.primaryLocationId,
    scheduleMode: f.scheduleMode,
    manualAttendance: f.manualAttendance,
    ...(f.startDate ? { startDate: f.startDate } : {}),
    ...(f.rank.trim() ? { rank: f.rank.trim() } : {}),
    ...(f.position.trim() ? { position: f.position.trim() } : {}),
  };
}

/** The body for PATCH /employees/:id: only what changed (an emptied rank or position is `null`, which removes it). */
export function patchBody(before: EmployeeDetail, f: EmployeeForm): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (f.lastName.trim() !== before.lastName) body.lastName = f.lastName.trim();
  if (f.firstName.trim() !== before.firstName) body.firstName = f.firstName.trim();
  if (f.departmentId !== before.departmentId) body.departmentId = f.departmentId;
  if (f.primaryLocationId !== before.primaryLocationId)
    body.primaryLocationId = f.primaryLocationId;
  if ((f.startDate || null) !== before.startDate) body.startDate = f.startDate || null;
  if (f.scheduleMode !== before.scheduleMode) body.scheduleMode = f.scheduleMode;
  if (f.manualAttendance !== before.manualAttendance) body.manualAttendance = f.manualAttendance;
  if ((f.rank.trim() || null) !== before.rank) body.rank = f.rank.trim() || null;
  if ((f.position.trim() || null) !== before.position) body.position = f.position.trim() || null;
  return body;
}

export function formFrom(e: EmployeeDetail): EmployeeForm {
  return {
    lastName: e.lastName,
    firstName: e.firstName,
    departmentId: e.departmentId,
    primaryLocationId: e.primaryLocationId,
    startDate: e.startDate ?? "",
    rank: e.rank ?? "",
    position: e.position ?? "",
    scheduleMode: e.scheduleMode,
    manualAttendance: e.manualAttendance,
  };
}

export const emptyForm: EmployeeForm = {
  lastName: "",
  firstName: "",
  departmentId: "",
  primaryLocationId: "",
  startDate: "",
  rank: "",
  position: "",
  scheduleMode: "STANDARD",
  manualAttendance: false,
};
