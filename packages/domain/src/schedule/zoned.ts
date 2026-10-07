import { type DateString, parseDate, timeToSeconds } from "./dates";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClock(instant: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

/** Offset of the zone from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function offsetMs(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` shows `date` + `time` (PRD 22.2: times are stored in UTC and
 * configured in local time). Two passes handle zones whose offset changes (daylight saving). For a local time that
 * does not exist or occurs twice, the result is one of the two valid neighbours.
 */
export function zonedTimeToInstant(date: DateString, time: string, timeZone: string): Date {
  const { year, month, day } = parseDate(date);
  const naive = Date.UTC(year, month - 1, day) + timeToSeconds(time) * 1000;
  let guess = naive - offsetMs(new Date(naive), timeZone);
  guess = naive - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** The calendar date of an instant in `timeZone` ("YYYY-MM-DD"). */
export function instantToLocalDate(instant: Date, timeZone: string): DateString {
  const w = wallClock(instant, timeZone);
  return `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}
