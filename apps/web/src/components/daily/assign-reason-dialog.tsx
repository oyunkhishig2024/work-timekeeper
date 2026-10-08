"use client";

import { useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { reasonFormProblem, type DailyItem, type Reason } from "@/lib/daily";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";

/** Give the employee a reason for this date (PRD 11): they become Шалтгаантай instead of Ирээгүй. «Бусад» needs words. */
export function AssignReasonDialog({
  row,
  date,
  reasons,
  onClose,
  onSaved,
}: {
  row: DailyItem;
  date: string;
  reasons: Reason[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reasonId, setReasonId] = useState("");
  const [description, setDescription] = useState("");
  const [toDate, setToDate] = useState(date);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reason = reasons.find((r) => r.id === reasonId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = reasonFormProblem(reason, description);
    if (problem) return setError(problem);
    if (toDate < date) return setError("Дуусах огноо эхлэх огнооноос өмнө байж болохгүй.");
    setBusy(true);
    setError(null);
    try {
      await api("/v1/reason-assignments", {
        method: "POST",
        body: {
          employeeIds: [row.employeeId],
          reasonId,
          fromDate: date,
          toDate,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Хадгалж чадсангүй.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Шалтгаан оноох" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        {row.fullName} · {date}
      </p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">
          Шалтгаан
          <select
            value={reasonId}
            onChange={(e) => setReasonId(e.target.value)}
            className={fieldClass}
            required
          >
            <option value="">Сонгоно уу</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Тайлбар{reason?.requiresDescription ? " (заавал)" : " (заавал биш)"}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={3}
            className={`${fieldClass} py-2`}
            required={reason?.requiresDescription}
          />
        </label>
        <label className="block text-sm font-medium">
          Хүртэл (эхний өдөр {date})
          <input
            type="date"
            min={date}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className={fieldClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
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
