import { addDays, daysBetween, daysInMonth, type DateString, formatDate, parseDate } from "./dates";

export interface Holiday {
  /** First and last day, inclusive. */
  fromDate: DateString;
  toDate: DateString;
  /** Fixed-date holidays repeat every year from the year of `fromDate` on (PRD 14.2). */
  repeatsYearly: boolean;
  appliesToAll: boolean;
  /** Locations the holiday applies to when `appliesToAll` is false. */
  locationIds: readonly string[];
}

/**
 * Does `date` fall inside the holiday?
 * - A yearly holiday also covers the same day-range in later years, never in years before its first occurrence
 *   (so a newly entered holiday cannot rewrite past attendance).
 * - A range that crosses New Year (30 Dec – 2 Jan) is found from the previous year's occurrence.
 * - A holiday starting on 29 February falls on 28 February in years that have none.
 */
export function holidayCovers(holiday: Holiday, date: DateString): boolean {
  if (date >= holiday.fromDate && date <= holiday.toDate) return true;
  if (!holiday.repeatsYearly) return false;

  const first = parseDate(holiday.fromDate);
  const spanDays = daysBetween(holiday.fromDate, holiday.toDate);
  const year = parseDate(date).year;
  for (const y of [year - 1, year]) {
    if (y < first.year) continue;
    const day = Math.min(first.day, daysInMonth(y, first.month));
    const start = formatDate(y, first.month, day);
    if (date >= start && date <= addDays(start, spanDays)) return true;
  }
  return false;
}

/** Does any holiday apply to this location on this date? */
export function isHoliday(
  holidays: readonly Holiday[],
  locationId: string,
  date: DateString,
): boolean {
  return holidays.some(
    (h) => (h.appliesToAll || h.locationIds.includes(locationId)) && holidayCovers(h, date),
  );
}
