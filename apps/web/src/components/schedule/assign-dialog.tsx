"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  createShiftAssignments,
  fetchShiftEmployees,
  shiftTimes,
  type ShiftPattern,
  type ShiftTemplate,
} from "@/lib/schedule";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

export function AssignDialog({
  templates,
  patterns,
  today,
  onClose,
  onSaved,
}: {
  templates: ShiftTemplate[];
  patterns: ShiftPattern[];
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [people, setPeople] = useState<Array<{
    id: string;
    fullName: string;
    employeeNo: string;
  }> | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [what, setWhat] = useState(
    patterns[0] ? `p:${patterns[0].id}` : `t:${templates[0]?.id ?? ""}`,
  );
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState("");
  const [cycleStart, setCycleStart] = useState("");
  const form = useFieldIssue("assign-form");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchShiftEmployees()
      .then(setPeople)
      .catch((e: unknown) => form.failure(message(e)));
  }, []);

  const isPattern = what.startsWith("p:");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen.size === 0) return form.issue("employees", "Ажилтан сонгоно уу.");
    setBusy(true);
    form.clear();
    try {
      await createShiftAssignments({
        employeeIds: [...chosen],
        patternId: isPattern ? what.slice(2) : null,
        templateId: isPattern ? null : what.slice(2),
        cycleStartDate: cycleStart || null,
        fromDate: from,
        toDate: to || null,
      });
      onSaved();
    } catch (e) {
      form.failure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Ээлж оноох" onClose={onClose}>
      <form ref={form.formRef} onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        <fieldset>
          <legend className="text-sm font-medium">Ажилтнууд (ээлжээр ажилладаг)</legend>
          {people === null ? (
            <p className="mt-1 text-sm text-slate-600">Ачаалж байна…</p>
          ) : people.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">
              Ээлжээр ажиллах ажилтан алга. Ажилтны хэсэгт «Ээлжээр» гэж тохируулна уу.
            </p>
          ) : (
            <ul className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-300 p-2">
              {people.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="employees"
                      checked={chosen.has(p.id)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        setChosen(next);
                      }}
                    />
                    {p.fullName} <span className="text-slate-500">{p.employeeNo}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <label className="block text-sm font-medium">
          Ээлж эсвэл мөчлөг
          <select value={what} onChange={(e) => setWhat(e.target.value)} className={fieldClass}>
            {patterns.map((p) => (
              <option key={p.id} value={`p:${p.id}`}>
                Мөчлөг: {p.name}
              </option>
            ))}
            {templates.map((t) => (
              <option key={t.id} value={`t:${t.id}`}>
                Ээлж: {t.name} ({shiftTimes(t)})
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Эхлэх огноо
            <input
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Дуусах огноо (заавал биш)
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={fieldClass}
            />
          </label>
        </div>
        {isPattern && (
          <label className="block text-sm font-medium">
            Мөчлөгийн 1-р өдөр (хоосон бол эхлэх огноо)
            <input
              type="date"
              value={cycleStart}
              onChange={(e) => setCycleStart(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        <FormError id={form.errorId} message={form.message} className="text-sm text-red-700" />
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" className={primaryButton} disabled={busy}>
            Оноох
          </button>
        </div>
      </form>
    </Modal>
  );
}
