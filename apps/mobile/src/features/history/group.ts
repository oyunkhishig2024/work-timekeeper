import type { MyDay } from "@/lib/api";

export interface Summary {
  onTime: number;
  late: number;
  noShow: number;
  excused: number;
  shortMinutes: number;
  overtimeMinutes: number;
}

export interface WeekGroup {
  /** Monday of the week, YYYY-MM-DD. */
  start: string;
  /** Sunday of the week. */
  end: string;
  summary: Summary;
  days: MyDay[];
}

export interface MonthGroup {
  /** YYYY-MM */
  key: string;
  summary: Summary;
  weeks: WeekGroup[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (date: string) => new Date(`${date}T00:00:00Z`);

export function mondayOf(date: string): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
}

export function sundayOf(date: string): string {
  const d = utc(mondayOf(date));
  d.setUTCDate(d.getUTCDate() + 6);
  return iso(d);
}

/** First and last day of a month ("2026-10" → 2026-10-01 .. 2026-10-31): the range the phone asks the API for when a folder opens. */
export function monthRange(key: string): { from: string; to: string } {
  const from = `${key}-01`;
  const next = utc(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  return { from, to: iso(next) };
}

export function summarize(days: readonly MyDay[]): Summary {
  const count = (status: MyDay["status"]) => days.filter((d) => d.status === status).length;
  return {
    onTime: count("ON_TIME"),
    late: count("LATE"),
    noShow: count("NO_SHOW"),
    excused: count("EXCUSED"),
    shortMinutes: days.reduce(
      (n, d) => n + (d.status === "LATE" ? d.lateMinutes : 0) + d.earlyLeaveMinutes,
      0,
    ),
    overtimeMinutes: days.reduce((n, d) => n + d.overtimeMinutes, 0),
  };
}

/** Months newest first, the weeks inside each newest first, the days inside each week newest first ("folders", PRD 4 / v1.28). */
export function groupHistory(days: readonly MyDay[]): MonthGroup[] {
  const months = new Map<string, MyDay[]>();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), day]);
  }
  return [...months.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, list]) => {
      const weeks = new Map<string, MyDay[]>();
      for (const day of list) {
        const monday = mondayOf(day.date);
        weeks.set(monday, [...(weeks.get(monday) ?? []), day]);
      }
      return {
        key,
        summary: summarize(list),
        weeks: [...weeks.entries()]
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([start, ds]) => ({
            start,
            end: sundayOf(start),
            summary: summarize(ds),
            days: [...ds].sort((a, b) => b.date.localeCompare(a.date)),
          })),
      };
    });
}

/** 95 → "1:35"; 0 → "0:00". */
export function hm(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
