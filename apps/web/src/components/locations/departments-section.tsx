"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import {
  createDepartment,
  fetchAllDepartments,
  updateDepartment,
  type DepartmentRow,
} from "@/lib/locations";
import { Modal } from "@/components/modal";
import { fieldClass } from "@/components/styles";
import { FormError } from "@/components/form-error";

const button =
  "min-h-11 rounded-md border border-slate-300 px-3 text-sm font-medium hover:bg-slate-100";
const primary =
  "min-h-11 rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-60";

const messageOf = (e: unknown) =>
  e instanceof ApiRequestError ? e.message : "Холбогдож чадсангүй. Дахин оролдоно уу.";

/** Org Admin: departments (нэгж, хэлтэс) used in the employee form and the filters. */
export function DepartmentsSection() {
  const [rows, setRows] = useState<DepartmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DepartmentRow | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchAllDepartments());
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">Хэлтэс, нэгж</h2>
        <button type="button" className={primary} onClick={() => setEditing("new")}>
          Хэлтэс нэмэх
        </button>
      </div>
      <FormError message={error} className="mt-3 text-sm text-red-700" />
      {rows === null ? (
        <p className="mt-4 text-slate-600">Ачаалж байна…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-slate-600">Хэлтэс алга. «Хэлтэс нэмэх» дарна уу.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 p-4">
              <p className="font-medium">
                {row.name}
                {!row.active && <span className="ml-2 text-sm text-slate-500">(идэвхгүй)</span>}
                {row.activeEmployees !== null && (
                  <span className="ml-2 text-sm text-slate-500">{row.activeEmployees} ажилтан</span>
                )}
              </p>
              <button type="button" className={button} onClick={() => setEditing(row)}>
                Засах
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <DepartmentDialog
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function DepartmentDialog({
  row,
  onClose,
  onSaved,
}: {
  row: DepartmentRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [active, setActive] = useState(row?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    setBusy(true);
    setError(null);
    try {
      if (row) await updateDepartment(row.id, { name, active });
      else await createDepartment(name);
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={row ? "Хэлтэс засах" : "Хэлтэс нэмэх"} onClose={onClose}>
      <form onSubmit={(e) => void onSubmit(e)} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">
          Нэр
          <input
            name="name"
            required
            defaultValue={row?.name}
            maxLength={120}
            className={fieldClass}
          />
        </label>
        {row && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Идэвхтэй
          </label>
        )}
        <FormError message={error} className="text-sm text-red-700" />
        <div className="flex justify-end gap-3">
          <button type="button" className={button} onClick={onClose}>
            Болих
          </button>
          <button type="submit" disabled={busy} className={primary}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}
