/**
 * Calendar arithmetic on plain dates written as "YYYY-MM-DD". Plain strings (not Date objects) are used on
 * purpose: a work date is a calendar concept, so it must never shift with the machine's time zone.
 */

export type DateString = string;

const MS_PER_DAY = 86_400_000;

export function parseDate(value: DateString): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new RangeError(`Invalid date "${value}" (expected YYYY-MM-DD)`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Invalid date "${value}"`);
  }
  return { year, month, day };
}

export const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function formatDate(year: number, month: number, day: number): DateString {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whole days since 1970-01-01. */
export function toEpochDay(value: DateString): number {
  const { year, month, day } = parseDate(value);
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function fromEpochDay(epochDay: number): DateString {
  const date = new Date(epochDay * MS_PER_DAY);
  return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export const addDays = (value: DateString, days: number): DateString =>
  fromEpochDay(toEpochDay(value) + days);

/** `to - from` in days (negative when `to` is earlier). */
export const daysBetween = (from: DateString, to: DateString): number =>
  toEpochDay(to) - toEpochDay(from);

/** ISO weekday: 1 = Monday … 7 = Sunday (the numbering the database uses). */
export function isoWeekday(value: DateString): number {
  const { year, month, day } = parseDate(value);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Modulo that is never negative, e.g. for cycle positions of dates before the cycle start. */
export const positiveMod = (n: number, m: number): number => ((n % m) + m) % m;

/** "08:30" or "08:30:00" → seconds since midnight. */
export function timeToSeconds(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) throw new RangeError(`Invalid time "${value}" (expected HH:MM or HH:MM:SS)`);
  const [h, m, s] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (h > 23 || m > 59 || s > 59) throw new RangeError(`Invalid time "${value}"`);
  return h * 3600 + m * 60 + s;
}
