"use client";

import { actionErrorText } from "@/components/api-error";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { type Option } from "@/lib/daily";
import { type EmployeeDetail } from "@/lib/employees";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { NoteDialog } from "../review/note-dialog";
import { FormError } from "@/components/form-error";

export function DisableDialog({
  today,
  employeeId,
  startDate,
  onClose,
  onSaved,
}: {
  today: string;
  employeeId: string;
  startDate: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(today);
  return (
    <NoteDialog
      title="Ажилтныг идэвхгүй болгох"
      intro={`Хүчинтэй болох огноо: ${date}. Нэвтрэх эрх, утас хаагдаж, хойшлох шалтгаан, түр томилолт цуцлагдана.`}
      label="Шалтгаан"
      required={false}
      submitLabel="Идэвхгүй болгох"
      validate={() =>
        date > today
          ? "Ирээдүйн огноо оруулж болохгүй."
          : startDate && date < startDate
            ? "Ажилд орсон огнооноос өмнө байж болохгүй."
            : null
      }
      onSubmit={async (note) => {
        try {
          await api(`/v1/employees/${employeeId}/disable`, {
            method: "POST",
            body: { effectiveDate: date, ...(note.trim() ? { reason: note.trim() } : {}) },
          });
        } catch (e) {
          throw new Error(actionErrorText(e));
        }
        onSaved();
      }}
      onClose={onClose}
      extra={
        <label className="block text-sm font-medium">
          Огноо
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            className={fieldClass}
          />
        </label>
      }
    />
  );
}

export function ReactivateDialog({
  today,
  employee,
  departments,
  locations,
  onClose,
  onSaved,
}: {
  today: string;
  employee: EmployeeDetail;
  departments: Option[];
  locations: Option[];
  onClose: () => void;
  onSaved: (password: { username: string; temporaryPassword: string } | null) => void;
}) {
  const [departmentId, setDepartmentId] = useState(employee.departmentId);
  const [locationId, setLocationId] = useState(employee.primaryLocationId);
  const [startDate, setStartDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // An employee who has a login gets a new one-time password with the reactivation (PRD 12.2).
      const res = await api<{ temporaryPassword?: string }>(
        `/v1/employees/${employee.id}/reactivate`,
        {
          method: "POST",
          body: { departmentId, primaryLocationId: locationId, startDate },
        },
      );
      const pw =
        res.temporaryPassword && employee.account
          ? { username: employee.account.username, temporaryPassword: res.temporaryPassword }
          : null;
      onSaved(pw);
    } catch (e) {
      setError(actionErrorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Дахин идэвхжүүлэх" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        Нэгж, салбараа дахин баталгаажуулна. Хуучин утас хаалттай хэвээр, шинэ QR хэрэгтэй.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">
          Нэгж
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className={fieldClass}
          >
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
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={fieldClass}
          >
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
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={fieldClass}
          />
        </label>
        <FormError message={error} className="text-sm text-red-700" />
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" disabled={busy} className={primaryButton}>
            Идэвхжүүлэх
          </button>
        </div>
      </form>
    </Modal>
  );
}
