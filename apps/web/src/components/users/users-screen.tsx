"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { SessionUser } from "@/lib/session";
import {
  fetchUsers,
  resetUserAuthenticator,
  resetUserPassword,
  ROLE_LABEL,
  scopeText,
  setUserStatus,
  userErrorText,
  type StaffUser,
} from "@/lib/users";
import { FormError } from "../form-error";
import { OneTimePasswordDialog } from "../one-time-password";
import { primaryButton, smallButton } from "../styles";

const AddUserDialog = dynamic(() => import("./add-user-dialog").then((m) => m.AddUserDialog));
const ScopeDialog = dynamic(() => import("./scope-dialog").then((m) => m.ScopeDialog));
const LinkDialog = dynamic(() => import("./link-dialog").then((m) => m.LinkDialog));

type Dialog =
  | { kind: "add" }
  | { kind: "scope"; user: StaffUser }
  | { kind: "link"; user: StaffUser }
  | { kind: "password"; username: string; password: string; then: StaffUser | null };

const dateText = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Ulaanbaatar" }).slice(0, 16) : "—";

/** Org Admin: the staff accounts (Org Admin, HR, Manager). Employee logins are managed on the employee page. */
export function UsersScreen({ user }: { user: SessionUser }) {
  const [rows, setRows] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchUsers());
    } catch (e) {
      setError(userErrorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>, done?: string) {
    setError(null);
    setMessage(null);
    try {
      await action();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setError(userErrorText(e));
    }
  }

  const resetPassword = (u: StaffUser) => {
    if (
      !window.confirm(
        `«${u.username}» нууц үгийг сэргээх үү? Хуучин нууц үг хүчингүй болж, бүх төхөөрөмжөөс гарна.`,
      )
    )
      return;
    void run(async () => {
      const r = await resetUserPassword(u.id);
      setDialog({
        kind: "password",
        username: u.username,
        password: r.temporaryPassword,
        then: null,
      });
    });
  };
  const resetAuthenticator = (u: StaffUser) => {
    if (
      !window.confirm(
        `«${u.username}» authenticator-ыг устгах уу? Дараагийн нэвтрэлтээр дахин тохируулна. Бүх төхөөрөмжөөс гарна.`,
      )
    )
      return;
    void run(async () => {
      await resetUserAuthenticator(u.id);
    }, "Authenticator-ыг устгалаа. Дараагийн нэвтрэлтээр дахин тохируулна.");
  };
  const toggleStatus = (u: StaffUser) => {
    const disable = u.status === "ACTIVE";
    if (
      disable &&
      !window.confirm(`«${u.username}» хэрэглэгчийг идэвхгүй болгох уу? Нэвтэрч чадахгүй болно.`)
    )
      return;
    void run(
      () => setUserStatus(u.id, disable ? "DISABLED" : "ACTIVE").then(() => undefined),
      disable ? "Идэвхгүй болголоо." : "Дахин идэвхжүүллээ.",
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Хэрэглэгчид</h1>
        <button type="button" className={primaryButton} onClick={() => setDialog({ kind: "add" })}>
          + Хэрэглэгч нэмэх
        </button>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Байгууллагын админ, Хүний нөөц, Менежерийн нэвтрэх эрх. Ажилтны нэвтрэх эрхийг{" "}
        <b>Ажилтнууд</b> хэсгийн ажилтны хуудаснаас удирдана.
      </p>
      <FormError message={error} className="mt-3 text-sm text-red-700" />
      {message && (
        <p role="status" className="mt-3 rounded-md bg-teal-50 p-2 text-sm text-teal-900">
          {message}
        </p>
      )}

      {rows === null ? (
        <p className="mt-4 text-slate-600">Ачаалж байна…</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((u) => {
            const self = u.id === user.id;
            const manageable = u.role !== "ORG_ADMIN" && !self;
            return (
              <li key={u.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {u.displayName} <span className="text-slate-500">· {u.username}</span>
                    {self && <span className="ml-2 text-sm text-slate-500">(та)</span>}
                  </span>
                  <span className="text-sm">
                    {ROLE_LABEL[u.role]} ·{" "}
                    <span className={u.status === "ACTIVE" ? "text-slate-700" : "text-red-700"}>
                      {u.status === "ACTIVE" ? "идэвхтэй" : "идэвхгүй"}
                    </span>
                  </span>
                </div>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
                  <div>
                    <dt className="inline text-slate-500">Харах хүрээ: </dt>
                    <dd className="inline">{scopeText(u)}</dd>
                  </div>
                  <div>
                    <dt className="inline text-slate-500">Сүүлд нэвтэрсэн: </dt>
                    <dd className="inline">
                      {u.mustChangePassword ? "Нууц үг солиогүй" : dateText(u.lastLoginAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-slate-500">Authenticator: </dt>
                    <dd className="inline">
                      {u.totpEnabled
                        ? "тохируулсан"
                        : u.role === "MANAGER"
                          ? "шаардлагагүй"
                          : "тохируулаагүй"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-slate-500">Ажилтны бүртгэл: </dt>
                    <dd className="inline">
                      {u.employeeName ?? (u.role === "BOSS" ? "ирц бүртгэгдэхгүй" : "холбоогүй")}
                    </dd>
                  </div>
                </dl>
                {manageable ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {u.role !== "BOSS" && (
                      <>
                        <button
                          type="button"
                          className={smallButton}
                          onClick={() => setDialog({ kind: "scope", user: u })}
                        >
                          Хамрах хүрээ
                        </button>
                        <button
                          type="button"
                          className={smallButton}
                          onClick={() => setDialog({ kind: "link", user: u })}
                        >
                          Ажилтантай холбох
                        </button>
                      </>
                    )}
                    <button type="button" className={smallButton} onClick={() => resetPassword(u)}>
                      Нууц үг сэргээх
                    </button>
                    {u.totpEnabled && (
                      <button
                        type="button"
                        className={smallButton}
                        onClick={() => resetAuthenticator(u)}
                      >
                        Authenticator сэргээх
                      </button>
                    )}
                    <button type="button" className={smallButton} onClick={() => toggleStatus(u)}>
                      {u.status === "ACTIVE" ? "Идэвхгүй болгох" : "Идэвхжүүлэх"}
                    </button>
                  </div>
                ) : u.role === "ORG_ADMIN" && !self ? (
                  <p className="mt-3 text-sm text-slate-600">
                    Байгууллагын админы нууц үгийг серверээс сэргээнэ
                    (docs/operations/forgot-password.md).
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {dialog?.kind === "add" && (
        <AddUserDialog
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            void load();
            setDialog({
              kind: "password",
              username: c.username,
              password: c.temporaryPassword,
              then:
                c.role === "MANAGER"
                  ? ({ id: c.id, displayName: c.username, role: "MANAGER" } as StaffUser)
                  : null,
            });
          }}
        />
      )}
      {dialog?.kind === "password" && (
        <OneTimePasswordDialog
          username={dialog.username}
          password={dialog.password}
          onClose={() => setDialog(dialog.then ? { kind: "scope", user: dialog.then } : null)}
        />
      )}
      {dialog?.kind === "scope" && (
        <ScopeDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setMessage("Хамрах хүрээг хадгаллаа.");
            void load();
          }}
        />
      )}
      {dialog?.kind === "link" && (
        <LinkDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setMessage("Ажилтны бүртгэлтэй холбох тохиргоог хадгаллаа.");
            void load();
          }}
        />
      )}
    </div>
  );
}
