"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  addTenantAdmin,
  dateText,
  fetchTenant,
  platformErrorText,
  renameTenant,
  resetTenantAdmin,
  setTenantStatus,
  type TenantDetail,
} from "@/lib/platform";
import { FormError } from "../form-error";
import { Modal } from "../modal";
import { OneTimePasswordDialog } from "../one-time-password";
import { fieldClass, primaryButton, secondaryButton, smallButton } from "../styles";

/** One organization: details, counts, its Organization Admins (add, reset) and suspend / activate. */
export function TenantDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [password, setPassword] = useState<{ username: string; password: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setTenant(await fetchTenant(id));
    } catch (e) {
      setError(platformErrorText(e));
    }
  }, [id]);
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
      setError(platformErrorText(e));
    }
  }

  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    if (!name || name === tenant?.name) return;
    void run(() => renameTenant(id, name).then(() => undefined), "Нэрийг хадгаллаа.");
  };

  const toggle = () => {
    if (!tenant) return;
    const suspend = tenant.status === "ACTIVE";
    if (
      suspend &&
      !window.confirm(
        `«${tenant.name}» байгууллагыг түдгэлзүүлэх үү? Бүх хэрэглэгч шууд нэвтрэх эрхгүй болно (утасны апп ч бас). Өгөгдөл устахгүй.`,
      )
    )
      return;
    void run(
      () => setTenantStatus(id, suspend ? "SUSPENDED" : "ACTIVE").then(() => undefined),
      suspend ? "Түдгэлзүүллээ." : "Дахин идэвхжүүллээ.",
    );
  };

  const reset = (username: string, totp: boolean) => {
    const text = totp
      ? `«${username}» админы нууц үг болон authenticator-ыг сэргээх үү?`
      : `«${username}» админы нууц үгийг сэргээх үү? Хуучин нууц үг хүчингүй болж, бүх төхөөрөмжөөс гарна.`;
    if (!window.confirm(text)) return;
    void run(async () => {
      const r = await resetTenantAdmin(id, username, totp);
      setPassword({ username: r.username, password: r.temporaryPassword });
    });
  };

  if (password) {
    return (
      <OneTimePasswordDialog
        username={password.username}
        password={password.password}
        onClose={() => setPassword(null)}
      />
    );
  }

  return (
    <Modal title={tenant ? `${tenant.name} · ${tenant.code}` : "Байгууллага"} onClose={onClose}>
      <FormError message={error} className="mt-3 text-sm text-red-700" />
      {message && (
        <p role="status" className="mt-3 rounded-md bg-teal-50 p-2 text-sm text-teal-900">
          {message}
        </p>
      )}
      {!tenant ? (
        !error && <p className="mt-3 text-slate-600">Ачаалж байна…</p>
      ) : (
        <div className="mt-3 space-y-5">
          <dl className="grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
            <div>
              <dt className="inline text-slate-500">Төлөв: </dt>
              <dd
                className={`inline ${tenant.status === "ACTIVE" ? "" : "font-medium text-red-700"}`}
              >
                {tenant.status === "ACTIVE" ? "идэвхтэй" : "түдгэлзүүлсэн"}
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Цагийн бүс: </dt>
              <dd className="inline">{tenant.timeZone}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Идэвхтэй ажилтан: </dt>
              <dd className="inline">{tenant.employees}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Удирдлагын эрх: </dt>
              <dd className="inline">{tenant.staffAccounts}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Үүсгэсэн: </dt>
              <dd className="inline">{dateText(tenant.createdAt)}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Сүүлд нэвтэрсэн: </dt>
              <dd className="inline">{dateText(tenant.lastLoginAt)}</dd>
            </div>
          </dl>

          <form onSubmit={rename} className="flex flex-wrap items-end gap-2">
            <label className="block flex-1 text-sm font-medium">
              Нэр
              <input
                name="name"
                defaultValue={tenant.name}
                maxLength={120}
                autoComplete="off"
                className={fieldClass}
              />
            </label>
            <button type="submit" className={smallButton}>
              Нэр солих
            </button>
          </form>

          <section aria-labelledby="admins-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="admins-title" className="font-medium">
                Байгууллагын админууд
              </h3>
              <button type="button" className={smallButton} onClick={() => setAddOpen((v) => !v)}>
                + Админ нэмэх
              </button>
            </div>
            {addOpen && (
              <AddAdminForm
                onAdd={(username, displayName) =>
                  run(async () => {
                    const r = await addTenantAdmin(id, username, displayName);
                    setAddOpen(false);
                    setPassword({ username: r.username, password: r.temporaryPassword });
                  })
                }
              />
            )}
            <ul className="mt-2 space-y-2">
              {tenant.admins.map((a) => (
                <li key={a.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {a.displayName} <span className="text-slate-500">· {a.username}</span>
                    </span>
                    <span className={a.status === "ACTIVE" ? "text-slate-700" : "text-red-700"}>
                      {a.status === "ACTIVE" ? "идэвхтэй" : "идэвхгүй"}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-600">
                    Authenticator: {a.totpEnabled ? "тохируулсан" : "тохируулаагүй"} · Сүүлд
                    нэвтэрсэн: {dateText(a.lastLoginAt)}
                  </p>
                  {a.status === "ACTIVE" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={smallButton}
                        onClick={() => reset(a.username, false)}
                      >
                        Нууц үг сэргээх
                      </button>
                      {a.totpEnabled && (
                        <button
                          type="button"
                          className={smallButton}
                          onClick={() => reset(a.username, true)}
                        >
                          Authenticator сэргээх
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-3">
            <button type="button" className={smallButton} onClick={toggle}>
              {tenant.status === "ACTIVE" ? "Түдгэлзүүлэх" : "Дахин идэвхжүүлэх"}
            </button>
            <button type="button" className={secondaryButton} onClick={onClose}>
              Хаах
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function AddAdminForm({
  onAdd,
}: {
  onAdd: (username: string, displayName: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username")).trim();
    const displayName = String(form.get("displayName")).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(username) || !displayName) {
      setProblem("Нэр, мөн латин нэвтрэх нэр (3-аас дээш тэмдэгт) бичнэ үү.");
      return;
    }
    setBusy(true);
    setProblem(null);
    await onAdd(username, displayName);
    setBusy(false);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 space-y-2 rounded-md bg-slate-50 p-3">
      <label className="block text-sm font-medium">
        Нэр
        <input name="displayName" maxLength={120} autoComplete="off" className={fieldClass} />
      </label>
      <label className="block text-sm font-medium">
        Нэвтрэх нэр
        <input
          name="username"
          maxLength={64}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          className={fieldClass}
        />
      </label>
      <FormError message={problem} className="text-sm text-red-700" />
      <button type="submit" disabled={busy} className={primaryButton}>
        Нэмэх
      </button>
    </form>
  );
}
