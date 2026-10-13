import { api } from "./api";

export const WEEKDAYS = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"] as const;

export interface WeekDay {
  weekday: number;
  working: boolean;
  start: string | null;
  end: string | null;
}

export interface WorkingWeek {
  id: string;
  validFrom: string;
  validTo: string | null;
  locationId: string | null;
  days: WeekDay[];
  /** A location without its own table shows the organization's. */
  inherited?: boolean;
}

export const DEFAULT_START = "08:30";
export const DEFAULT_END = "17:30";

const q = (params: Record<string, string | null | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const text = s.toString();
  return text ? `?${text}` : "";
};

export const fetchWorkingWeek = (locationId: string | null) =>
  api<WorkingWeek>(`/v1/working-week${q({ locationId })}`);

export const putWorkingWeek = (input: {
  locationId: string | null;
  effectiveFrom: string;
  days: WeekDay[];
}) =>
  api<WorkingWeek>("/v1/working-week", {
    method: "PUT",
    body: {
      ...(input.locationId ? { locationId: input.locationId } : {}),
      effectiveFrom: input.effectiveFrom,
      days: input.days.map((d) =>
        d.working
          ? { weekday: d.weekday, working: true, start: d.start, end: d.end }
          : { weekday: d.weekday, working: false },
      ),
    },
  });

/** The start date of a change that is saved but has not begun yet (versions are newest first), or null. */
export async function upcomingStart(
  kind: "working-week" | "attendance-rules",
  locationId: string | null,
  today: string,
): Promise<string | null> {
  const versions = await api<Array<{ validFrom: string }>>(
    `/v1/${kind}/versions${q({ locationId })}`,
  );
  return versions.find((v) => v.validFrom > today)?.validFrom ?? null;
}

export const inheritWorkingWeek = (locationId: string, effectiveFrom: string) =>
  api("/v1/working-week/inherit", { method: "POST", body: { locationId, effectiveFrom } });

// ----------------------------------------------------------------------------------------------- attendance rules

export interface Rules {
  id: string | null;
  validFrom: string | null;
  source: "LOCATION" | "TENANT" | "DEFAULT";
  graceMinutes: number;
  minStayMinutes: number;
  earlyLeaveToleranceMinutes: number;
}

export const fetchRules = (locationId: string | null) =>
  api<Rules>(`/v1/attendance-rules${q({ locationId })}`);

export const putRules = (input: {
  locationId: string | null;
  effectiveFrom: string;
  graceMinutes: number;
  minStayMinutes: number;
  earlyLeaveToleranceMinutes: number;
}) =>
  api<Rules>("/v1/attendance-rules", {
    method: "PUT",
    body: {
      ...(input.locationId ? { locationId: input.locationId } : {}),
      effectiveFrom: input.effectiveFrom,
      graceMinutes: input.graceMinutes,
      minStayMinutes: input.minStayMinutes,
      earlyLeaveToleranceMinutes: input.earlyLeaveToleranceMinutes,
    },
  });

// ----------------------------------------------------------------------------------------------------- holidays

export type HolidayKind = "PUBLIC_HOLIDAY" | "COMPANY_DAY_OFF" | "TRANSFERRED_DAY_OFF";

export const HOLIDAY_KIND_LABEL: Record<HolidayKind, string> = {
  PUBLIC_HOLIDAY: "Нийтийн баярын өдөр",
  COMPANY_DAY_OFF: "Байгууллагын амралт",
  TRANSFERRED_DAY_OFF: "Шилжүүлсэн амралт",
};

export interface Holiday {
  id: string;
  name: string;
  fromDate: string;
  toDate: string;
  kind: HolidayKind;
  repeatsYearly: boolean;
  appliesToAll: boolean;
  locationIds: string[];
}

export interface HolidayInput {
  name: string;
  fromDate: string;
  toDate: string;
  kind: HolidayKind;
  repeatsYearly: boolean;
  appliesToAll: boolean;
  locationIds: string[];
}

export const fetchHolidays = (year: number) => api<Holiday[]>(`/v1/holidays?year=${year}`);

export const createHoliday = (input: HolidayInput, confirmRecompute: boolean) =>
  api<Holiday>("/v1/holidays", {
    method: "POST",
    body: { ...input, ...(confirmRecompute ? { confirmRecompute: true } : {}) },
  });

export const updateHoliday = (id: string, input: HolidayInput, confirmRecompute: boolean) =>
  api<Holiday>(`/v1/holidays/${id}`, {
    method: "PATCH",
    body: { ...input, ...(confirmRecompute ? { confirmRecompute: true } : {}) },
  });

export const deleteHoliday = (id: string, confirmRecompute: boolean) =>
  api(`/v1/holidays/${id}${confirmRecompute ? "?confirmRecompute=true" : ""}`, {
    method: "DELETE",
  });

export const copyHolidayYear = (fromYear: number, toYear: number) =>
  api<unknown>("/v1/holidays/copy-year", { method: "POST", body: { fromYear, toYear } });

// ------------------------------------------------------------------------------- single-date working-day exceptions

export interface DayException {
  id: string;
  locationId: string | null;
  date: string;
  working: boolean;
  start: string | null;
  end: string | null;
  note: string | null;
}

export const fetchExceptions = (from: string, to: string) =>
  api<DayException[]>(`/v1/working-day-exceptions${q({ from, to })}`);

export const createException = (input: {
  date: string;
  working: boolean;
  start: string | null;
  end: string | null;
  locationId: string | null;
  note: string | null;
}) =>
  api<DayException>("/v1/working-day-exceptions", {
    method: "POST",
    body: {
      date: input.date,
      working: input.working,
      ...(input.working && input.start && input.end ? { start: input.start, end: input.end } : {}),
      ...(input.locationId ? { locationId: input.locationId } : {}),
      ...(input.note ? { note: input.note } : {}),
    },
  });

export const deleteException = (id: string) =>
  api(`/v1/working-day-exceptions/${id}`, { method: "DELETE" });

/** "08:30" is before "17:30": both are zero-padded, so a text comparison is enough. */
export const timesInOrder = (start: string | null, end: string | null) =>
  Boolean(start && end && start < end);

/** What the person sees for an API error code of the schedule screens. */
export function scheduleError(code: string, fallback: string): string {
  switch (code) {
    case "EFFECTIVE_DATE_IN_PAST":
      return "Хүчинтэй болох огноо өнгөрсөн байж болохгүй. Өнөөдөр эсвэл дараагийн өдрийг сонгоно уу.";
    case "EFFECTIVE_DATE_NOT_AFTER_CURRENT":
      return "Одоогийн хуваарь энэ огнооноос өмнө эсвэл өдөр эхэлсэн. Дараагийн өдрийг сонгоно уу.";
    case "EXCEPTION_EXISTS":
      return "Энэ өдөр онцгой тохиргоо байна. Эхлээд устгана уу.";
    case "HOLIDAY_NAME_TAKEN":
    case "HOLIDAY_EXISTS":
      return "Энэ нэр, огноотой баяр аль хэдийн бүртгэгдсэн байна.";
    default:
      return fallback;
  }
}

// ------------------------------------------------------------------------------------------- shifts (PRD 23)

export interface ShiftTemplate {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  endsNextDay: boolean;
  graceMinutes: number;
  observesHolidays: boolean;
  active: boolean;
  inUse: boolean;
}

export interface TemplateInput {
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  observesHolidays: boolean;
}

export const fetchShiftTemplates = () => api<ShiftTemplate[]>("/v1/shift-templates");
export const createShiftTemplate = (input: TemplateInput) =>
  api<ShiftTemplate>("/v1/shift-templates", { method: "POST", body: input });
export const newShiftTemplateVersion = (id: string, input: Omit<TemplateInput, "name">) =>
  api<ShiftTemplate>(`/v1/shift-templates/${id}/new-version`, { method: "POST", body: input });
export const patchShiftTemplate = (id: string, body: { name?: string; active?: boolean }) =>
  api<ShiftTemplate>(`/v1/shift-templates/${id}`, { method: "PATCH", body });

export interface ShiftPattern {
  id: string;
  name: string;
  cycleLengthDays: number;
  active: boolean;
  /** One entry per day of the cycle: a template id, or null for a day off. */
  days: Array<string | null>;
  inUse: boolean;
}

export const fetchShiftPatterns = () => api<ShiftPattern[]>("/v1/shift-patterns");
export const createShiftPattern = (input: { name: string; days: Array<string | null> }) =>
  api<ShiftPattern>("/v1/shift-patterns", { method: "POST", body: input });
export const patchShiftPattern = (id: string, body: { name?: string; active?: boolean }) =>
  api<ShiftPattern>(`/v1/shift-patterns/${id}`, { method: "PATCH", body });

export interface ShiftAssignment {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  patternId: string | null;
  patternName: string | null;
  templateId: string | null;
  templateName: string | null;
  cycleStartDate: string | null;
  fromDate: string;
  toDate: string | null;
}

export const fetchShiftAssignments = () =>
  api<ShiftAssignment[] | { items: ShiftAssignment[] }>("/v1/shift-assignments?limit=500").then(
    (r) => (Array.isArray(r) ? r : r.items),
  );
export const createShiftAssignments = (input: {
  employeeIds: string[];
  patternId: string | null;
  templateId: string | null;
  cycleStartDate: string | null;
  fromDate: string;
  toDate: string | null;
}) =>
  api("/v1/shift-assignments", {
    method: "POST",
    body: {
      items: input.employeeIds.map((employeeId) => ({ employeeId })),
      ...(input.patternId
        ? { patternId: input.patternId, cycleStartDate: input.cycleStartDate ?? input.fromDate }
        : { templateId: input.templateId }),
      fromDate: input.fromDate,
      ...(input.toDate ? { toDate: input.toDate } : {}),
    },
  });
export const endShiftAssignment = (id: string, toDate: string) =>
  api(`/v1/shift-assignments/${id}/end`, { method: "POST", body: { toDate } });
export const deleteShiftAssignment = (id: string) =>
  api(`/v1/shift-assignments/${id}`, { method: "DELETE" });

export const fetchShiftEmployees = () =>
  api<{ items: Array<{ id: string; fullName: string; employeeNo: string }> }>(
    "/v1/employees?status=ACTIVE&scheduleMode=SHIFT&limit=200&sort=employeeNo",
  ).then((r) => r.items);

/** "08:00 – 20:00" (a shift that ends the next day says so). */
export const shiftTimes = (t: Pick<ShiftTemplate, "startTime" | "endTime" | "endsNextDay">) =>
  `${t.startTime} – ${t.endTime}${t.endsNextDay ? " (маргааш)" : ""}`;
