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
