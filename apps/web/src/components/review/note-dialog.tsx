"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";

/** Asks for a note and hands it to `onSubmit`; a failure is shown here and keeps the dialog open. */
export function NoteDialog({
  title,
  intro,
  label,
  required,
  submitLabel,
  validate,
  onSubmit,
  onClose,
  extra,
}: {
  title: string;
  intro: string;
  label: string;
  required: boolean;
  submitLabel: string;
  validate?: (note: string) => string | null;
  onSubmit: (note: string) => Promise<void>;
  onClose: () => void;
  /** More fields above the note (a date, a choice). */
  extra?: ReactNode;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = validate?.(note) ?? null;
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Хадгалж чадсангүй.");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">{intro}</p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        {extra}
        <label className="block text-sm font-medium">
          {label}
          {required ? " (заавал)" : " (заавал биш)"}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            className={`${fieldClass} py-2`}
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
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
