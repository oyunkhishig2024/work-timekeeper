"use client";

import { useEffect, useState } from "react";
import { fetchEmployees, type EmployeeListItem } from "@/lib/employees";
import { linkEmployee, userErrorText, type StaffUser } from "@/lib/users";
import { FormError } from "../form-error";
import { Modal } from "../modal";
import { fieldClass, secondaryButton, smallButton } from "../styles";

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
  const [q, setQ] = useState("");
  const [found, setFound] = useState<EmployeeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setFound(null);
      return;
    }
    const timer = setTimeout(() => {
      void fetchEmployees({
        q,
        status: "ACTIVE",
        departmentId: null,
        locationId: null,
        page: 1,
      }).then(
        (res) => setFound(res.items.slice(0, 8)),
        (e: unknown) => setError(userErrorText(e)),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

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
        Холбосны дараа тухайн хүн өөрийн утсаа бүртгүүлж, ирцээ өөрөө бүртгэнэ. Вэб апп өмнөх шигээ
        ажиллана.
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
      <label className="mt-3 block text-sm font-medium">
        Ажилтан хайх (нэр эсвэл код)
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={100}
          autoComplete="off"
          className={fieldClass}
        />
      </label>
      {found !== null && (
        <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
          {found.length === 0 && <li className="p-3 text-sm text-slate-600">Олдсонгүй.</li>}
          {found.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 p-2">
              <span className="text-sm">
                {e.fullName} <span className="text-slate-500">{e.employeeNo}</span>
              </span>
              <button type="button" className={smallButton} onClick={() => void link(e.id)}>
                Холбох
              </button>
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} className="mt-2 text-sm text-red-700" />
      <div className="mt-3 flex justify-end">
        <button type="button" className={secondaryButton} onClick={onClose}>
          Хаах
        </button>
      </div>
    </Modal>
  );
}
