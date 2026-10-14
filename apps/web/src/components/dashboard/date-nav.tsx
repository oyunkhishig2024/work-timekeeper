"use client";

import { addDaysIso, weekdayMn } from "@/lib/attendance";
import { LinkButton } from "../link-button";
import { compactField, smallButton } from "../styles";

/**
 * Previous day / Today / Next day (PRD 7) as links to `hrefFor(date)` (null when `date` is today: no date in the address),
 * and a date picker that calls `onPick`.
 */
export function DateNav({
  date,
  today,
  hrefFor,
  onPick,
}: {
  date: string;
  today: string;
  hrefFor: (date: string) => string;
  onPick: (date: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <LinkButton href={hrefFor(addDaysIso(date, -1))} className={smallButton} label="Өмнөх өдөр">
        ‹ Өмнөх
      </LinkButton>
      <LinkButton href={hrefFor(today)} className={smallButton} disabled={date === today}>
        Өнөөдөр
      </LinkButton>
      <LinkButton href={hrefFor(addDaysIso(date, 1))} className={smallButton} label="Дараах өдөр">
        Дараах ›
      </LinkButton>
      <label className="ml-auto flex items-center gap-2 text-sm text-slate-700">
        <span className="hidden sm:inline">
          {date} · {weekdayMn(date)}
        </span>
        <span className="sr-only">Огноо сонгох</span>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className={compactField}
        />
      </label>
    </div>
  );
}
