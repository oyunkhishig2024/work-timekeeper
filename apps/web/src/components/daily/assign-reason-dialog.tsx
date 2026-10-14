"use client";

import { useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { overlapNames, reasonFormProblem, type DailyItem, type Reason } from "@/lib/daily";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

/** Give one or more employees a reason from this date (PRD 11): they become Шалтгаантай instead of Ирээгүй. «Бусад» needs words. All or nothing. */
export function AssignReasonDialog({
  rows,
  date,
  reasons,
  onClose,
  onSaved,
}: {
  rows: DailyItem[];
  date: string;
  reasons: Reason[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reasonId, setReasonId] = useState("");
  const [description, setDescription] = useState("");
  const [toDate, setToDate] = useState(date);
  const form = useFieldIssue("assign-reason-form");
  const [busy, setBusy] = useState(false);
  const reason = reasons.find((r) => r.id === reasonId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = reasonFormProblem(reason, description);
    if (problem) return form.issue(reason ? "description" : "reasonId", problem);
    if (toDate < date)
      return form.issue("toDate", "Дуусах огноо эхлэх огнооноос өмнө байж болохгүй.");
    setBusy(true);
    form.clear();
    try {
      await api("/v1/reason-assignments", {
        method: "POST",
        body: {
          employeeIds: rows.map((r) => r.employeeId),
          reasonId,
          fromDate: date,
          toDate,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
      onSaved();
    } catch (e) {
      const clash =
        e instanceof ApiRequestError && e.code === "REASON_OVERLAP"
          ? overlapNames(e.extra, rows)
          : [];
      form.failure(
        clash.length > 0
          ? `Дараах ажилтанд энэ хугацаанд шалтгаан оноогдсон байна: ${clash.join(", ")}. Сонголтоос хасаад дахин оролдоно уу.`
          : e instanceof ApiRequestError
            ? e.message
            : "Хадгалж чадсангүй.",
      );
      setBusy(false);
    }
  }

  return (
    <Modal title="Шалтгаан оноох" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        {rows.length === 1 ? rows[0]!.fullName : `${rows.length} ажилтан`} · {date}
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
        <label className="block text-sm font-medium">
          Шалтгаан
          <select
            name="reasonId"
            {...form.flag("reasonId")}
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
            name="description"
            {...form.flag("description")}
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
            name="toDate"
            {...form.flag("toDate")}
            min={date}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
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
