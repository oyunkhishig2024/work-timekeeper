"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import type { Option } from "@/lib/daily";
import {
  copyHolidayYear,
  createException,
  createHoliday,
  deleteException,
  deleteHoliday,
  fetchExceptions,
  fetchHolidays,
  HOLIDAY_KIND_LABEL,
  scheduleError,
  timesInOrder,
  updateHoliday,
  type DayException,
  type Holiday,
  type HolidayInput,
  type HolidayKind,
} from "@/lib/schedule";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";

const message = (e: unknown) =>
  e instanceof ApiRequestError
    ? scheduleError(e.code, e.message)
    : "Холбогдож чадсангүй. Дахин оролдоно уу.";
const needsConfirm = (e: unknown) =>
  e instanceof ApiRequestError && e.code === "RECOMPUTE_CONFIRMATION_REQUIRED";
const RECOMPUTE_TEXT =
  "Энэ өдөр өнөөдөр эсвэл өнгөрсөн тул бүртгэгдсэн ирц өөрчлөгдөнө. Үргэлжлүүлэх үү?";

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
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
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

function HolidayDialog({
  row,
  today,
  year,
  locations,
  onClose,
  onSaved,
}: {
  row: Holiday | null;
  today: string;
  year: number;
  locations: Option[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [fromDate, setFrom] = useState(row?.fromDate ?? `${year}-01-01`);
  const [toDate, setTo] = useState(row?.toDate ?? row?.fromDate ?? `${year}-01-01`);
  const [kind, setKind] = useState<HolidayKind>(row?.kind ?? "PUBLIC_HOLIDAY");
  const [repeatsYearly, setRepeats] = useState(row?.repeatsYearly ?? false);
  const [appliesToAll, setAll] = useState(row?.appliesToAll ?? true);
  const [locationIds, setIds] = useState<string[]>(row?.locationIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (toDate < fromDate) return setError("Дуусах огноо эхлэх огнооноос өмнө байна.");
    if (!appliesToAll && locationIds.length === 0)
      return setError("Хамгийн багадаа нэг салбар сонгоно уу.");
    const input: HolidayInput = {
      name: name.trim(),
      fromDate,
      toDate,
      kind,
      repeatsYearly,
      appliesToAll,
      locationIds: appliesToAll ? [] : locationIds,
    };
    const send = (confirm: boolean) =>
      row ? updateHoliday(row.id, input, confirm) : createHoliday(input, confirm);
    setBusy(true);
    setError(null);
    try {
      try {
        await send(false);
      } catch (e) {
        if (!needsConfirm(e) || !window.confirm(RECOMPUTE_TEXT)) throw e;
        await send(true);
      }
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={row ? "Баяр засах" : "Баяр нэмэх"} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">
          Нэр
          <input
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Эхлэх огноо
            <input
              type="date"
              required
              value={fromDate}
              onChange={(e) => {
                setFrom(e.target.value);
                if (toDate < e.target.value) setTo(e.target.value);
              }}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Дуусах огноо
            <input
              type="date"
              required
              min={fromDate}
              value={toDate}
              onChange={(e) => setTo(e.target.value)}
              className={fieldClass}
            />
          </label>
        </div>
        <label className="block text-sm font-medium">
          Төрөл
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as HolidayKind)}
            className={fieldClass}
          >
            {(Object.keys(HOLIDAY_KIND_LABEL) as HolidayKind[]).map((k) => (
              <option key={k} value={k}>
                {HOLIDAY_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={repeatsYearly}
            onChange={(e) => setRepeats(e.target.checked)}
          />
          Жил бүр давтагдана
        </label>
        <fieldset className="text-sm">
          <legend className="font-medium">Хамрах салбар</legend>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" checked={appliesToAll} onChange={() => setAll(true)} />
            Бүх салбар
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" checked={!appliesToAll} onChange={() => setAll(false)} />
            Сонгосон салбар
          </label>
          {!appliesToAll && (
            <ul className="mt-2 space-y-1 pl-6">
              {locations.map((l) => (
                <li key={l.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={locationIds.includes(l.id)}
                      onChange={(e) =>
                        setIds(
                          e.target.checked
                            ? [...locationIds, l.id]
                            : locationIds.filter((x) => x !== l.id),
                        )
                      }
                    />
                    {l.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        {fromDate <= today && (
          <p className="text-xs text-amber-800">
            Өнөөдөр эсвэл өнгөрсөн өдөр тул хадгалахад ирцийг дахин тооцно (баталгаажуулалт асууна).
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" disabled={busy} className={primaryButton}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** One date made a working day (optionally with its own hours) or a day off, for the whole organization or one branch. */
function ExceptionsPanel({
  canEdit,
  today,
  locations,
}: {
  canEdit: boolean;
  today: string;
  locations: Option[];
}) {
  const [rows, setRows] = useState<DayException[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const names = new Map(locations.map((l) => [l.id, l.name]));

  const load = useCallback(async () => {
    try {
      setRows(await fetchExceptions(today, addDays(today, 180)));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [today]);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(x: DayException) {
    if (!window.confirm(`${x.date} өдрийн онцгой тохиргоог устгах уу?`)) return;
    try {
      await deleteException(x.id);
      await load();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Онцгой өдөр</h2>
        {canEdit && (
          <button type="button" className={primaryButton} onClick={() => setAdding(true)}>
            Онцгой өдөр нэмэх
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Нэг өдрийг ажлын өдөр (өөр цагтай байж болно) эсвэл амралт болгоно. Ажлын долоо хоногоос
        давуу. Дараагийн 180 хоног.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {rows === null ? (
        <p className="mt-4 text-slate-600">Ачаалж байна…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-slate-600">Онцгой өдөр алга.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {rows.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  {x.date} ·{" "}
                  {x.working ? `Ажлын өдөр${x.start ? ` ${x.start}–${x.end}` : ""}` : "Амралт"}
                </p>
                <p className="text-sm text-slate-600">
                  {x.locationId ? (names.get(x.locationId) ?? "—") : "Бүх байгууллага"}
                  {x.note ? ` · ${x.note}` : ""}
                </p>
              </div>
              {canEdit && (
                <button type="button" className={secondaryButton} onClick={() => void remove(x)}>
                  Устгах
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <ExceptionDialog
          today={today}
          locations={locations}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

function ExceptionDialog({
  today,
  locations,
  onClose,
  onSaved,
}: {
  today: string;
  locations: Option[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(today);
  const [working, setWorking] = useState(true);
  const [ownHours, setOwnHours] = useState(false);
  const [start, setStart] = useState("08:30");
  const [end, setEnd] = useState("17:30");
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working && ownHours && !timesInOrder(start, end)) {
      return setError("Эхлэх цаг дуусах цагаас өмнө байх ёстой.");
    }
    setBusy(true);
    setError(null);
    try {
      await createException({
        date,
        working,
        start: working && ownHours ? start : null,
        end: working && ownHours ? end : null,
        locationId: locationId || null,
        note: note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Онцгой өдөр нэмэх" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">
          Огноо
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={fieldClass}
          />
        </label>
        <fieldset className="text-sm">
          <legend className="font-medium">Энэ өдөр</legend>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" checked={working} onChange={() => setWorking(true)} />
            Ажлын өдөр
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" checked={!working} onChange={() => setWorking(false)} />
            Амралт
          </label>
        </fieldset>
        {working && (
          <div className="text-sm">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={ownHours}
                onChange={(e) => setOwnHours(e.target.checked)}
              />
              Өөр цагтай
            </label>
            {ownHours && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="min-h-11 rounded-md border border-slate-300 px-2"
                />
                –
                <input
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="min-h-11 rounded-md border border-slate-300 px-2"
                />
              </div>
            )}
            {!ownHours && (
              <p className="mt-1 text-xs text-slate-500">Ажлын долоо хоногийн цагаар.</p>
            )}
          </div>
        )}
        <label className="block text-sm font-medium">
          Хамаарах газар
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={fieldClass}
          >
            <option value="">Бүх байгууллага</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Тэмдэглэл (заавал биш)
          <input
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={fieldClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" disabled={busy} className={primaryButton}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}
