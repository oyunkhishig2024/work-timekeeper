/**
 * The instant at which the wall clock of `timeZone` shows `date` `hhmm` (for example the arrival time HR types in the
 * organization's zone). Works for any IANA zone, daylight saving included; a time that does not exist (the hour skipped in spring)
 * resolves to the instant just after the gap.
 */
export function zonedTimeToIso(date: string, hhmm: string, timeZone: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // How far the zone's wall clock is ahead of UTC at instant `t`.
  const offsetAt = (t: number): number => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(t)).map((p) => [p.type, Number(p.value)]),
    );
    return (
      Date.UTC(
        parts.year!,
        parts.month! - 1,
        parts.day!,
        parts.hour!,
        parts.minute!,
        parts.second!,
      ) - t
    );
  };
  // Two rounds settle the offset even when it changes between the first guess and the answer.
  let t = wanted - offsetAt(wanted);
  t = wanted - offsetAt(t);
  return new Date(t).toISOString();
}

/** "HH:MM" of an instant on the wall clock of `timeZone` (what the time input of a form is prefilled with). */
export function isoToZonedTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
