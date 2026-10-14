"use client";

import { useState, type FormEvent } from "react";
import { createShiftPattern, shiftTimes, type ShiftTemplate } from "@/lib/schedule";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { FormError } from "@/components/form-error";

export function PatternDialog({
  templates,
  onClose,
  onSaved,
}: {
  templates: ShiftTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [days, setDays] = useState<string[]>([templates[0]?.id ?? "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createShiftPattern({ name: name.trim(), days: days.map((d) => d || null) });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Ээлжийн мөчлөг нэмэх" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
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
        <ol className="space-y-2">
          {days.map((d, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-16 text-sm">{i + 1}-р өдөр</span>
              <select
                aria-label={`${i + 1}-р өдөр`}
                value={d}
                onChange={(e) => setDays(days.map((x, j) => (j === i ? e.target.value : x)))}
                className={fieldClass}
              >
                <option value="">Амралт</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({shiftTimes(t)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={secondaryButton}
                disabled={days.length <= 1}
                aria-label={`${i + 1}-р өдрийг хасах`}
                onClick={() => setDays(days.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className={secondaryButton} onClick={() => setDays([...days, ""])}>
          Өдөр нэмэх
        </button>
        <FormError message={error} className="text-sm text-red-700" />
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" className={primaryButton} disabled={busy || days.every((d) => !d)}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}
