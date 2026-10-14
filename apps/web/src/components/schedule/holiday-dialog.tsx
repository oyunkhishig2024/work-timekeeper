"use client";

import { useState, type FormEvent } from "react";
import type { Option } from "@/lib/daily";
import {
  createHoliday,
  HOLIDAY_KIND_LABEL,
  updateHoliday,
  type Holiday,
  type HolidayInput,
  type HolidayKind,
} from "@/lib/schedule";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { needsConfirm, RECOMPUTE_TEXT } from "./recompute-confirm";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

export function HolidayDialog({
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
  const form = useFieldIssue("holiday-form");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (toDate < fromDate) return form.issue("toDate", "Дуусах огноо эхлэх огнооноос өмнө байна.");
    if (!appliesToAll && locationIds.length === 0)
      return form.issue("branches", "Хамгийн багадаа нэг салбар сонгоно уу.");
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
    form.clear();
    try {
      try {
        await send(false);
      } catch (e) {
        if (!needsConfirm(e) || !window.confirm(RECOMPUTE_TEXT)) throw e;
        await send(true);
      }
      onSaved();
    } catch (e) {
      form.failure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={row ? "Баяр засах" : "Баяр нэмэх"} onClose={onClose}>
      <form ref={form.formRef} onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
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
              name="toDate"
              {...form.flag("toDate")}
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
            <input
              type="radio"
              name="branches"
              {...form.flag("branches")}
              checked={!appliesToAll}
              onChange={() => setAll(false)}
            />
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
