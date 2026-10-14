"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Option } from "@/lib/daily";
import {
  createException,
  deleteException,
  fetchExceptions,
  timesInOrder,
  type DayException,
} from "@/lib/schedule";
import { Modal } from "../modal";
import { compactField, fieldClass, primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** One date made a working day (optionally with its own hours) or a day off, for the whole organization or one branch. */
export function ExceptionsPanel({
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
      <FormError message={error} className="mt-2 text-sm text-red-700" />
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

export function ExceptionDialog({
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
  const form = useFieldIssue("exception-form");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working && ownHours && !timesInOrder(start, end)) {
      return form.issue("endTime", "Эхлэх цаг дуусах цагаас өмнө байх ёстой.");
    }
    setBusy(true);
    form.clear();
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
      form.failure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Онцгой өдөр нэмэх" onClose={onClose}>
      <form ref={form.formRef} onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
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
                  className={compactField}
                />
                –
                <input
                  type="time"
                  name="endTime"
                  {...form.flag("endTime")}
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className={compactField}
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
        <FormError id={form.errorId} message={form.message} className="text-sm text-red-700" />
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
