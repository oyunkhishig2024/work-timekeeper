"use client";

import { useCallback, useEffect, useState } from "react";
import type { Option } from "@/lib/daily";
import {
  copyHolidayYear,
  deleteHoliday,
  fetchHolidays,
  HOLIDAY_KIND_LABEL,
  type Holiday,
} from "@/lib/schedule";
import { primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { needsConfirm, RECOMPUTE_TEXT } from "./recompute-confirm";
import { FormError } from "@/components/form-error";
import { HolidayDialog } from "./holiday-dialog";
import { ExceptionsPanel } from "./exceptions-panel";

const range = (h: Holiday) =>
  h.fromDate === h.toDate ? h.fromDate : `${h.fromDate} → ${h.toDate}`;

/** Holidays (PRD 14.2) and single-date working-day exceptions (PRD 14.1). */
export function HolidaysSection({
  canEdit,
  today,
  locations,
}: {
  canEdit: boolean;
  today: string;
  locations: Option[];
}) {
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [rows, setRows] = useState<Holiday[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Holiday | "new" | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchHolidays(year));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [year]);
  useEffect(() => {
    void load();
  }, [load]);

  const names = new Map(locations.map((l) => [l.id, l.name]));

  async function remove(h: Holiday) {
    if (!window.confirm(`«${h.name}» баярыг устгах уу?`)) return;
    setError(null);
    try {
      try {
        await deleteHoliday(h.id, false);
      } catch (e) {
        if (!needsConfirm(e) || !window.confirm(RECOMPUTE_TEXT)) throw e;
        await deleteHoliday(h.id, true);
      }
      await load();
    } catch (e) {
      setError(message(e));
    }
  }

  async function copyFromPrevious() {
    if (!window.confirm(`${year - 1} оны баярыг ${year} онд хуулах уу? Давхардсан нь алгасагдана.`))
      return;
    setError(null);
    try {
      await copyHolidayYear(year - 1, year);
      setInfo(`${year - 1} оны баярыг хууллаа.`);
      await load();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="space-y-10">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Баярын өдрүүд</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={secondaryButton} onClick={() => setYear(year - 1)}>
              ‹ {year - 1}
            </button>
            <b className="px-2">{year}</b>
            <button type="button" className={secondaryButton} onClick={() => setYear(year + 1)}>
              {year + 1} ›
            </button>
            {canEdit && (
              <>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void copyFromPrevious()}
                >
                  Өмнөх оноос хуулах
                </button>
                <button type="button" className={primaryButton} onClick={() => setEditing("new")}>
                  Баяр нэмэх
                </button>
              </>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Баярын өдөр хэн ч ажиллах ёстой биш. Ажилласан хүний ирсэн, гарсан цаг л тэмдэглэгдэнэ.
        </p>
        {info && (
          <p role="status" className="mt-2 text-sm text-teal-800">
            {info}
          </p>
        )}
        <FormError message={error} className="mt-2 text-sm text-red-700" />
        {rows === null ? (
          <p className="mt-4 text-slate-600">Ачаалж байна…</p>
        ) : rows.length === 0 ? (
          <p className="mt-4 text-slate-600">{year} онд баяр бүртгэгдээгүй байна.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {rows.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">
                    {h.name}
                    {h.repeatsYearly && (
                      <span className="ml-2 text-xs text-slate-500">жил бүр</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-600">
                    {range(h)} · {HOLIDAY_KIND_LABEL[h.kind]} ·{" "}
                    {h.appliesToAll
                      ? "бүх салбар"
                      : h.locationIds.map((id) => names.get(id) ?? "—").join(", ")}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <button type="button" className={secondaryButton} onClick={() => setEditing(h)}>
                      Засах
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => void remove(h)}
                    >
                      Устгах
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ExceptionsPanel canEdit={canEdit} today={today} locations={locations} />

      {editing && (
        <HolidayDialog
          row={editing === "new" ? null : editing}
          today={today}
          year={year}
          locations={locations}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
