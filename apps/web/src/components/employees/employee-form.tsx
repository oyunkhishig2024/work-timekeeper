"use client";

import { useRef, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import type { Option } from "@/lib/daily";
import { employeeFormIssue, type EmployeeForm } from "@/lib/employees";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";
import { FormError } from "@/components/form-error";

/** Create / edit form of an employee (PRD 12). The code is assigned by the system, so it is not a field. */
export function EmployeeFormDialog({
  title,
  initial,
  departments,
  locations,
  rankSuggestions,
  positionSuggestions,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: EmployeeForm;
  departments: Option[];
  locations: Option[];
  rankSuggestions: string[];
  positionSuggestions: string[];
  submitLabel: string;
  onSubmit: (form: EmployeeForm) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  /** The field the error is about, so it can be marked and focused. Null for a server error about the whole form. */
  const [errorField, setErrorField] = useState<keyof EmployeeForm | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  /** aria-invalid / aria-describedby for a field. */
  const flag = (key: keyof EmployeeForm) =>
    errorField === key
      ? ({ "aria-invalid": true, "aria-describedby": "employee-form-error" } as const)
      : {};
  const set = <K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const issue = employeeFormIssue(form);
    if (issue) {
      setError(issue.message);
      setErrorField(issue.field);
      formRef.current?.querySelector<HTMLElement>(`[name="${issue.field}"]`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setErrorField(null);
    try {
      await onSubmit(form);
    } catch (e) {
      setErrorField(null);
      setError(e instanceof ApiRequestError ? e.message : "Хадгалж чадсангүй.");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form ref={formRef} onSubmit={submit} className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Овог
            <input
              name="lastName"
              {...flag("lastName")}
              value={form.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              maxLength={80}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Нэр
            <input
              name="firstName"
              {...flag("firstName")}
              value={form.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              maxLength={80}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Цол
            <input
              name="rank"
              {...flag("rank")}
              value={form.rank}
              onChange={(e) => set("rank", e.target.value)}
              list="rank-suggestions"
              maxLength={120}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Албан тушаал
            <input
              name="position"
              {...flag("position")}
              value={form.position}
              onChange={(e) => set("position", e.target.value)}
              list="position-suggestions"
              maxLength={120}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Нэгж
            <select
              name="departmentId"
              {...flag("departmentId")}
              value={form.departmentId}
              onChange={(e) => set("departmentId", e.target.value)}
              className={fieldClass}
            >
              <option value="">Сонгоно уу</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Үндсэн салбар
            <select
              name="primaryLocationId"
              {...flag("primaryLocationId")}
              value={form.primaryLocationId}
              onChange={(e) => set("primaryLocationId", e.target.value)}
              className={fieldClass}
            >
              <option value="">Сонгоно уу</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Ажилд орсон огноо
            <input
              type="date"
              name="startDate"
              {...flag("startDate")}
              value={form.startDate}
              onChange={(e) => set("startDate", e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Ажлын хуваарь
            <select
              value={form.scheduleMode}
              onChange={(e) => set("scheduleMode", e.target.value as EmployeeForm["scheduleMode"])}
              className={fieldClass}
            >
              <option value="STANDARD">Энгийн (ажлын долоо хоног)</option>
              <option value="SHIFT">Ээлжийн</option>
            </select>
          </label>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.manualAttendance}
            onChange={(e) => set("manualAttendance", e.target.checked)}
          />
          Гараар ирц бүртгэнэ (утасгүй)
        </label>
        <datalist id="rank-suggestions">
          {rankSuggestions.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <datalist id="position-suggestions">
          {positionSuggestions.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <FormError id="employee-form-error" message={error} className="text-sm text-red-700" />
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
