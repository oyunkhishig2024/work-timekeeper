"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { dateText, fetchTenants, platformErrorText, type Tenant } from "@/lib/platform";
import { FormError } from "../form-error";
import { OneTimePasswordDialog } from "../one-time-password";
import { chipClass, primaryButton, smallButton } from "../styles";
import { ActivityList } from "./activity-list";

const CreateTenantDialog = dynamic(() =>
  import("./create-tenant-dialog").then((m) => m.CreateTenantDialog),
);
const TenantDialog = dynamic(() => import("./tenant-dialog").then((m) => m.TenantDialog));

type Dialog =
  | { kind: "create" }
  | { kind: "tenant"; id: string }
  | { kind: "password"; username: string; password: string };

/** Super Admin: the organizations of the platform, with counts only (no attendance data), and what happened lately. */
export function TenantsScreen() {
  const [tab, setTab] = useState<"orgs" | "activity">("orgs");
  const [rows, setRows] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchTenants());
    } catch (e) {
      setError(platformErrorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Байгууллагууд</h1>
        <button
          type="button"
          className={primaryButton}
          onClick={() => setDialog({ kind: "create" })}
        >
          + Байгууллага нэмэх
        </button>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Энд зөвхөн байгууллагын тоо баримт харагдана. Ажилтны ирцийн мэдээлэл харагдахгүй.
      </p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Хэсэг">
        <button
          type="button"
          aria-pressed={tab === "orgs"}
          className={chipClass(tab === "orgs")}
          onClick={() => setTab("orgs")}
        >
          Байгууллагууд
        </button>
        <button
          type="button"
          aria-pressed={tab === "activity"}
          className={chipClass(tab === "activity")}
          onClick={() => setTab("activity")}
        >
          Үйл ажиллагаа
        </button>
      </div>
      <FormError message={error} className="mt-3 text-sm text-red-700" />
      {message && (
        <p role="status" className="mt-3 rounded-md bg-teal-50 p-2 text-sm text-teal-900">
          {message}
        </p>
      )}

      {tab === "activity" ? (
        <ActivityList />
      ) : rows === null ? (
        <p className="mt-4 text-slate-600">Ачаалж байна…</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((t) => (
            <li key={t.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {t.name} <span className="text-slate-500">· {t.code}</span>
                </span>
                <span
                  className={`text-sm ${t.status === "ACTIVE" ? "text-slate-700" : "font-medium text-red-700"}`}
                >
                  {t.status === "ACTIVE" ? "идэвхтэй" : "түдгэлзүүлсэн"}
                </span>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
                <div>
                  <dt className="inline text-slate-500">Идэвхтэй ажилтан: </dt>
                  <dd className="inline">{t.employees}</dd>
                </div>
                <div>
                  <dt className="inline text-slate-500">Удирдлагын эрх: </dt>
                  <dd className="inline">{t.staffAccounts}</dd>
                </div>
                <div>
                  <dt className="inline text-slate-500">Сүүлд нэвтэрсэн: </dt>
                  <dd className="inline">{dateText(t.lastLoginAt)}</dd>
                </div>
                <div>
                  <dt className="inline text-slate-500">Сүүлийн ирцийн бүртгэл: </dt>
                  <dd className="inline">{dateText(t.lastEventAt)}</dd>
                </div>
              </dl>
              <div className="mt-3">
                <button
                  type="button"
                  className={smallButton}
                  onClick={() => setDialog({ kind: "tenant", id: t.id })}
                >
                  Дэлгэрэнгүй, удирдах
                </button>
              </div>
            </li>
          ))}
          {rows.length === 0 && <li className="text-slate-600">Байгууллага алга.</li>}
        </ul>
      )}

      {dialog?.kind === "create" && (
        <CreateTenantDialog
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            void load();
            setMessage(`«${c.name}» байгууллагыг үүсгэлээ.`);
            setDialog({ kind: "password", username: c.username, password: c.password });
          }}
        />
      )}
      {dialog?.kind === "password" && (
        <OneTimePasswordDialog
          username={dialog.username}
          password={dialog.password}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "tenant" && (
        <TenantDialog
          id={dialog.id}
          onClose={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
