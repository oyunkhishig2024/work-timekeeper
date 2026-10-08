"use client";

import { useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { STATUS_LABEL } from "@/lib/attendance";
import { CORRECTION_REASONS, correctionFormProblem, type DailyItem } from "@/lib/daily";
import { isoToZonedTime, zonedTimeToIso } from "@/lib/time";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";

type Choice = "ON_TIME" | "LATE" | "NO_SHOW";

/** Manual correction of the day (PRD 6.9): a reason is mandatory; the system value is kept next to the corrected one. */
export function CorrectionDialog({
  row,
  date,
  timeZone,
  onClose,
  onSaved,
}: {
  row: DailyItem;
  date: string;
  timeZone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<Choice>(row.status === "LATE" ? "LATE" : "ON_TIME");
  const [arrival, setArrival] = useState(
    row.arrivalAt ? isoToZonedTime(row.arrivalAt, timeZone) : "",
  );
  const [reasonCode, setReasonCode] = useState("PHONE_DEAD_LOST");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Хадгалж чадсангүй.");
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = correctionFormProblem({ status, arrival, reasonCode, note });
    if (problem) return setError(problem);
    void call(() =>
      api("/v1/attendance/corrections", {
        method: "POST",
        body: {
          employeeId: row.employeeId,
          workDate: date,
          status,
          arrivalAt:
            status !== "NO_SHOW" && arrival ? zonedTimeToIso(date, arrival, timeZone) : null,
          reasonCode,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    );
  }

  const choice = (value: Choice) => (
    <label key={value} className="flex min-h-11 items-center gap-2">
      <input
        type="radio"
        name="status"
        checked={status === value}
        onChange={() => setStatus(value)}
      />
      {STATUS_LABEL[value]}
    </label>
  );

  return (
    <Modal title="Ирцийг засах" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        {row.fullName} · {date}
        {row.source === "CORRECTED" && row.systemStatus
          ? ` · системийн утга: ${STATUS_LABEL[row.systemStatus as keyof typeof STATUS_LABEL] ?? row.systemStatus}`
          : ""}
      </p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <fieldset>
          <legend className="text-sm font-medium">Шинэ төлөв</legend>
          <div className="mt-1 flex flex-wrap gap-x-4">
            {(["ON_TIME", "LATE", "NO_SHOW"] as const).map(choice)}
          </div>
        </fieldset>
        {status !== "NO_SHOW" && (
          <label className="block text-sm font-medium">
            Ирсэн цаг (заавал биш)
            <input
              type="time"
              value={arrival}
              onChange={(e) => setArrival(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        <label className="block text-sm font-medium">
          Засварын шалтгаан
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            className={fieldClass}
          >
            {CORRECTION_REASONS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Тайлбар{reasonCode === "OTHER" ? " (заавал)" : " (заавал биш)"}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            className={`${fieldClass} py-2`}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          {row.correctionId ? (
            <button
              type="button"
              disabled={busy}
              className={secondaryButton}
              onClick={() =>
                void call(() =>
                  api(`/v1/attendance/corrections/${row.correctionId}/revoke`, {
                    method: "POST",
                    body: {},
                  }),
                )
              }
            >
              Засварыг цуцлах
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={onClose}>
              Болих
            </button>
            <button type="submit" disabled={busy} className={primaryButton}>
              Засах
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
