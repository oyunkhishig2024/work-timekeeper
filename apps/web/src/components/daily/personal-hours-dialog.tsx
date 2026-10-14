"use client";

import { useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { overlapNames, personalHoursIssue, type DailyItem, type Option } from "@/lib/daily";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

/**
 * Fix the hours (and, when needed, the places) of the selected employees for a range of dates (PRD 14.3): they replace the
 * usual week, a holiday or a shift for those dates. Several places mean one day worked at all of them; the first ticked is
 * the main one. All or nothing.
 */
export function PersonalHoursDialog({
  rows,
  date,
  locations,
  onClose,
  onSaved,
}: {
  rows: DailyItem[];
  date: string;
  locations: Option[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fromDate, setFromDate] = useState(date);
  const [toDate, setToDate] = useState(date);
  const [startTime, setStartTime] = useState("06:30");
  const [endTime, setEndTime] = useState("14:00");
  /** In the order they were ticked: the first is the main place. */
  const [places, setPlaces] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const form = useFieldIssue("personal-hours-form");
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setPlaces((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const issue = personalHoursIssue({ fromDate, toDate, startTime, endTime });
    if (issue) return form.issue(issue.field, issue.message);
    setBusy(true);
    form.clear();
    try {
      await api("/v1/personal-hours", {
        method: "POST",
        body: {
          employeeIds: rows.map((r) => r.employeeId),
          fromDate,
          toDate,
          startTime,
          endTime,
          locationIds: places,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      onSaved();
    } catch (e) {
      const clash =
        e instanceof ApiRequestError && e.code === "PERSONAL_HOURS_OVERLAP"
          ? overlapNames(
              { conflicts: (e.extra as { conflicts?: unknown } | undefined)?.conflicts },
              rows,
            )
          : [];
      form.failure(
        clash.length > 0
          ? `Дараах ажилтанд энэ хугацаанд хувийн цаг тогтоосон байна: ${clash.join(", ")}. Сонголтоос хасаад дахин оролдоно уу.`
          : e instanceof ApiRequestError
            ? e.message
            : "Хадгалж чадсангүй.",
      );
      setBusy(false);
    }
  }

  return (
    <Modal title="Ажлын цаг тогтоох" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        {rows.length === 1 ? rows[0]!.fullName : `${rows.length} ажилтан`}
      </p>
      {rows.length > 1 && (
        <ul
          aria-label="Сонгосон ажилтнууд"
          className="mt-2 flex max-h-28 flex-wrap gap-1 overflow-y-auto text-xs"
        >
          {rows.map((r) => (
            <li key={r.employeeId} className="rounded-full bg-teal-50 px-2 py-0.5 text-teal-900">
              {r.fullName}
            </li>
          ))}
        </ul>
      )}
      <form ref={form.formRef} onSubmit={submit} className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Эхлэх огноо
            <input
              type="date"
              name="fromDate"
              {...form.flag("fromDate")}
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className={fieldClass}
              required
            />
          </label>
          <label className="block text-sm font-medium">
            Дуусах огноо
            <input
              type="date"
              name="toDate"
              {...form.flag("toDate")}
              min={fromDate}
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className={fieldClass}
              required
            />
          </label>
          <label className="block text-sm font-medium">
            Ажил эхлэх цаг
            <input
              type="time"
              name="startTime"
              {...form.flag("startTime")}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={fieldClass}
              required
            />
          </label>
          <label className="block text-sm font-medium">
            Ажил тарах цаг
            <input
              type="time"
              name="endTime"
              {...form.flag("endTime")}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className={fieldClass}
              required
            />
          </label>
        </div>
        <fieldset className="rounded-md border border-slate-300 px-3 pb-2 pt-1">
          <legend className="px-1 text-sm font-medium">Ажиллах байршил</legend>
          <p className="text-xs text-slate-600">
            Сонгохгүй бол ажилтны ердийн байршил. Хэд хэдэн байршил сонговол бүгдэд нь ажилласан
            хугацаа тооцогдоно; эхэнд сонгосон нь үндсэн байршил.
          </p>
          <div className="mt-1 flex flex-wrap gap-x-5">
            {locations.map((l) => (
              <label key={l.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={places.includes(l.id)}
                  onChange={() => toggle(l.id)}
                />
                {l.name}
                {places[0] === l.id && places.length > 1 && (
                  <span className="rounded-full bg-slate-100 px-2 text-xs">үндсэн</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-sm font-medium">
          Тэмдэглэл (заавал биш)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Жишээ: эрт ирээрэй гэсэн"
            className={fieldClass}
          />
        </label>
        <FormError id={form.errorId} message={form.message} className="text-sm text-red-700" />
        <div className="flex justify-end gap-2">
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
