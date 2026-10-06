const MS_PER_MINUTE = 60_000;

/** Truncate a date to whole minutes (PRD 6.2: evaluation is at minute precision). */
export function truncateToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_MINUTE);
}
