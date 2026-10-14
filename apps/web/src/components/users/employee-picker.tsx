"use client";

import { useEffect, useState, type InputHTMLAttributes } from "react";
import { fetchEmployees, type EmployeeListItem } from "@/lib/employees";
import { userErrorText } from "@/lib/users";
import { fieldClass, smallButton } from "../styles";

/** Searches the active employees by name or code and offers each hit with a button; `onPick` gets the chosen one. */
export function EmployeePicker({
  label,
  buttonLabel,
  onPick,
  onError,
  inputProps,
}: {
  label: string;
  buttonLabel: string;
  onPick: (employee: EmployeeListItem) => void;
  onError?: (message: string) => void;
  /** Extra attributes of the search field (name, aria-invalid, aria-describedby). */
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<EmployeeListItem[] | null>(null);

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
        (e: unknown) => onError?.(userErrorText(e)),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [q, onError]);

  return (
    <div>
      <label className="block text-sm font-medium">
        {label}
        <input
          {...inputProps}
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
              <button type="button" className={smallButton} onClick={() => onPick(e)}>
                {buttonLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
