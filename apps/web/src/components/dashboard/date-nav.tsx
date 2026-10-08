"use client";

import { addDaysIso, weekdayMn } from "@/lib/attendance";

const btn =
  "min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-100";

/** Previous day / Today / Next day (PRD 7) and a date picker. */
export function DateNav({
  date,
  today,
  onChange,
}: {
  date: string;
  today: string;
  onChange: (date: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={btn}
        onClick={() => onChange(addDaysIso(date, -1))}
        aria-label="Өмнөх өдөр"
      >
        ‹ Өмнөх
      </button>
      <button
        type="button"
        className={btn}
        disabled={date === today}
        onClick={() => onChange(today)}
      >
        Өнөөдөр
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(addDaysIso(date, 1))}
        aria-label="Дараах өдөр"
      >
        Дараах ›
      </button>
      <label className="ml-auto flex items-center gap-2 text-sm text-slate-700">
        <span className="hidden sm:inline">
          {date} · {weekdayMn(date)}
        </span>
        <span className="sr-only">Огноо сонгох</span>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-2"
        />
      </label>
    </div>
  );
}
