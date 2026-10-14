"use client";

import { actionErrorText } from "@/components/api-error";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

export function TitleDialog({
  today,
  kind,
  current,
  suggestions,
  startDate,
  employeeId,
  onClose,
  onSaved,
}: {
  /** The organization's date, not the browser's: the server rejects a date that is still in the future for it. */
  today: string;
  kind: "rank" | "position";
  current: string | null;
  suggestions: string[];
  startDate: string | null;
  employeeId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const form = useFieldIssue("title-form");
  const [busy, setBusy] = useState(false);
  const label = kind === "rank" ? "Шинэ цол" : "Шинэ албан тушаал";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return form.issue("title", `${label} бичнэ үү.`);
    if (date > today) return form.issue("effectiveDate", "Ирээдүйн огноо оруулж болохгүй.");
    if (startDate && date < startDate)
      return form.issue("effectiveDate", "Ажилд орсон огнооноос өмнө байж болохгүй.");
    setBusy(true);
    form.clear();
    try {
      await api(`/v1/employees/${employeeId}/${kind}`, {
        method: "PUT",
        body: {
          [kind]: value.trim(),
          effectiveDate: date,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      onSaved();
    } catch (e) {
      form.failure(actionErrorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal title={kind === "rank" ? "Цол өөрчлөх" : "Албан тушаал өөрчлөх"} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        Одоогийн: {current ?? "—"}. Нөгөөг нь хөндөхгүй, түүхэнд тусад нь хадгална. Өнөөдөр
        бүртгэсэн утгыг «Засах»-аар засна.
      </p>
      <form ref={form.formRef} onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">
          {label}
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            list={`${kind}-list`}
            name="title"
            {...form.flag("title")}
            maxLength={120}
            className={fieldClass}
          />
          <datalist id={`${kind}-list`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="block text-sm font-medium">
          Хүчинтэй болох огноо
          <input
            type="date"
            value={date}
            name="effectiveDate"
            {...form.flag("effectiveDate")}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Тэмдэглэл (тушаалын дугаар гэх мэт, заавал биш)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
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
