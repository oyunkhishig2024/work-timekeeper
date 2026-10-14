"use client";

import { useEffect, useState, type FormEvent } from "react";
import { fetchDepartments, fetchLocations, type Option } from "@/lib/daily";
import { fetchScope, putScope, ROLE_LABEL, userErrorText, type StaffUser } from "@/lib/users";
import { FormError } from "../form-error";
import { Modal } from "../modal";
import { primaryButton, secondaryButton } from "../styles";

function Group({
  legend,
  name,
  options,
  chosen,
  onToggle,
}: {
  legend: string;
  name: string;
  options: Option[];
  chosen: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{legend}</legend>
      {options.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">Одоогоор байхгүй.</p>
      ) : (
        <ul className="mt-1 max-h-40 overflow-auto rounded-md border border-slate-300 p-2">
          {options.map((o) => (
            <li key={o.id}>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={name}
                  checked={chosen.has(o.id)}
                  onChange={() => onToggle(o.id)}
                />
                {o.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** Which departments and branches an HR or Manager account may see (PRD 4). */
export function ScopeDialog({
  user,
  onClose,
  onSaved,
}: {
  user: Pick<StaffUser, "id" | "displayName" | "role">;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [departments, setDepartments] = useState<Option[] | null>(null);
  const [locations, setLocations] = useState<Option[]>([]);
  const [deps, setDeps] = useState<Set<string>>(new Set());
  const [locs, setLocs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([fetchDepartments(), fetchLocations(), fetchScope(user.id)]).then(
      ([d, l, s]) => {
        setDepartments(d);
        setLocations(l);
        setDeps(new Set(s.departmentIds));
        setLocs(new Set(s.locationIds));
      },
      (e: unknown) => setError(userErrorText(e)),
    );
  }, [user.id]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void) => (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await putScope(user.id, { departmentIds: [...deps], locationIds: [...locs] });
      onSaved();
    } catch (e) {
      setError(userErrorText(e));
      setBusy(false);
    }
  }

  const none = deps.size === 0 && locs.size === 0;
  return (
    <Modal title="Хамрах хүрээ" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        {user.displayName} · {ROLE_LABEL[user.role]}
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        {departments === null ? (
          <p className="text-slate-600">Ачаалж байна…</p>
        ) : (
          <>
            <Group
              legend="Хэлтэс, нэгж"
              name="departments"
              options={departments}
              chosen={deps}
              onToggle={toggle(deps, setDeps)}
            />
            <Group
              legend="Салбар (байршил)"
              name="locations"
              options={locations}
              chosen={locs}
              onToggle={toggle(locs, setLocs)}
            />
            <p
              className={`rounded-md p-2 text-sm ${none && user.role === "MANAGER" ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-700"}`}
            >
              {none
                ? user.role === "MANAGER"
                  ? "Юу ч сонгоогүй бол Менежер ямар ч ажилтан харахгүй."
                  : "Юу ч сонгоогүй бол Хүний нөөц бүх ажилтныг харна."
                : "Сонгосон хэлтэс, салбарын ажилтныг харна."}
            </p>
          </>
        )}
        <FormError message={error} className="text-sm text-red-700" />
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" disabled={busy || departments === null} className={primaryButton}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}
