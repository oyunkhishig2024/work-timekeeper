"use client";

import { useState, type FormEvent } from "react";
import { createShiftTemplate, newShiftTemplateVersion, type ShiftTemplate } from "@/lib/schedule";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

export function TemplateDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing?: ShiftTemplate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [start, setStart] = useState(existing?.startTime ?? "08:00");
  const [end, setEnd] = useState(existing?.endTime ?? "20:00");
  const [grace, setGrace] = useState(String(existing?.graceMinutes ?? 0));
  const [holidays, setHolidays] = useState(existing?.observesHolidays ?? false);
  const form = useFieldIssue("template-form");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (start === end) return form.issue("endTime", "Эхлэх, дуусах цаг ижил байж болохгүй.");
    setBusy(true);
    form.clear();
    const timing = {
      startTime: start,
      endTime: end,
      graceMinutes: Number(grace) || 0,
      observesHolidays: holidays,
    };
    try {
      if (existing) await newShiftTemplateVersion(existing.id, timing);
      else await createShiftTemplate({ name: name.trim(), ...timing });
      onSaved();
    } catch (e) {
      form.failure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `«${existing.name}» — цаг өөрчлөх` : "Ээлж нэмэх"} onClose={onClose}>
      <form ref={form.formRef} onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        {existing ? (
          <p className="text-sm text-slate-600">
            {existing.inUse
              ? "Энэ ээлж ашиглагдаж байгаа тул шинэ хувилбар үүснэ. Хуучин ээлж хаагдана, өмнөх өдрүүд өөрчлөгдөхгүй."
              : "Шинэ хувилбар үүснэ."}
          </p>
        ) : (
          <label className="block text-sm font-medium">
            Нэр
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Эхлэх цаг
            <input
              type="time"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Дуусах цаг
            <input
              type="time"
              required
              name="endTime"
              {...form.flag("endTime")}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className={fieldClass}
            />
          </label>
        </div>
        <p className="text-sm text-slate-600">
          Дуусах цаг эхлэхээс өмнө бол маргааш дуусна (шөнийн ээлж: 20:00 → 08:00).
        </p>
        <label className="block text-sm font-medium">
          Хоцролтын хүлцэл (минут)
          <input
            type="number"
            min={0}
            max={240}
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={holidays}
            onChange={(e) => setHolidays(e.target.checked)}
          />
          Баярын өдөр амарна
        </label>
        <FormError id={form.errorId} message={form.message} className="text-sm text-red-700" />
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" className={primaryButton} disabled={busy}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}
