import { isValidIsoDate } from "../common/dates";

export const YES = new Set(["yes", "y", "true", "1", "тийм", "x"]);
export const NO = new Set(["no", "n", "false", "0", "үгүй", ""]);

/** `YYYY-MM-DD`, `YYYY.MM.DD` or `YYYY/M/D` as a real calendar date; anything else is null. */
export function parseDate(value: string): string | null {
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/u.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  return isValidIsoDate(iso) ? iso : null;
}
