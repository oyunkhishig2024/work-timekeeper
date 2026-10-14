"use client";

import { useState } from "react";
import { linkEmployee, userErrorText, type StaffUser } from "@/lib/users";
import { FormError } from "../form-error";
import { Modal } from "../modal";
import { secondaryButton, smallButton } from "../styles";
import { EmployeePicker } from "./employee-picker";

/** Links a staff account to the person's own employee record, so they register a phone and record their own attendance. */
export function LinkDialog({
  user,
  onClose,
  onSaved,
}: {
  user: Pick<StaffUser, "id" | "displayName" | "employeeId" | "employeeName">;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function link(employeeId: string | null) {
    setError(null);
    try {
      await linkEmployee(user.id, employeeId);
      onSaved();
    } catch (e) {
      setError(userErrorText(e));
    }
  }

  return (
    <Modal title="Ажилтны бүртгэлтэй холбох" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">{user.displayName}</p>
      <p className="mt-2 text-sm text-slate-600">
        Холбосны дараа тухайн хүн өөрийн утсаа бүртгүүлж, ирц, гарсан цагаа бүртгүүлнэ. Вэб апп
        өмнөх шигээ ажиллана.
      </p>
      {user.employeeId && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          Одоогийн холбоо: <b>{user.employeeName}</b>
          <div className="mt-2">
            <button type="button" className={smallButton} onClick={() => void link(null)}>
              Холбоог салгах
            </button>
          </div>
        </div>
      )}
      <div className="mt-3">
        <EmployeePicker
          label="Ажилтан хайх (нэр эсвэл код)"
          buttonLabel="Холбох"
          onPick={(e) => void link(e.id)}
          onError={setError}
        />
      </div>
      <FormError message={error} className="mt-2 text-sm text-red-700" />
      <div className="mt-3 flex justify-end">
        <button type="button" className={secondaryButton} onClick={onClose}>
          Хаах
        </button>
      </div>
    </Modal>
  );
}
