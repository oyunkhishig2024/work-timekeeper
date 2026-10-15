"use client";

import { useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import { createTenant, platformErrorText, type NewTenantForm } from "@/lib/platform";
import { FormError } from "../form-error";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { useFieldIssue } from "../use-field-issue";

const CODE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/u;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const FIELD_OF: Record<string, string> = {
  CODE_TAKEN: "code",
  CODE_RESERVED: "code",
  INVALID_TIME_ZONE: "timeZone",
};

/** Super Admin adds an organization with its first Organization Admin; the answer carries the admin's one-time password. */
export function CreateTenantDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: { name: string; username: string; password: string }) => void;
}) {
  const [form, setForm] = useState<NewTenantForm>({
    code: "",
    name: "",
    timeZone: "Asia/Ulaanbaatar",
    adminUsername: "",
    adminDisplayName: "",
  });
  const [busy, setBusy] = useState(false);
  const issues = useFieldIssue("create-tenant-form");
  const set = (patch: Partial<NewTenantForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const code = form.code.trim().toLowerCase();
    if (!form.name.trim()) return issues.issue("name", "Байгууллагын нэрийг бичнэ үү.");
    if (!CODE_RE.test(code)) {
      return issues.issue("code", "Код: 2-32 тэмдэгт, жижиг латин үсэг, тоо, зураас.");
    }
    if (!form.adminDisplayName.trim())
      return issues.issue("adminDisplayName", "Админы нэрийг бичнэ үү.");
    if (!USERNAME_RE.test(form.adminUsername.trim())) {
      return issues.issue(
        "adminUsername",
        "Нэвтрэх нэр: латин үсэг, тоо, цэг, зураас (3-аас дээш).",
      );
    }
    setBusy(true);
    issues.clear();
    try {
      const res = await createTenant({
        ...form,
        code,
        name: form.name.trim(),
        adminUsername: form.adminUsername.trim(),
        adminDisplayName: form.adminDisplayName.trim(),
      });
      onCreated({
        name: res.tenant.name,
        username: res.admin.username,
        password: res.admin.temporaryPassword,
      });
    } catch (e) {
      const field = e instanceof ApiRequestError ? FIELD_OF[e.code] : undefined;
      if (field) issues.issue(field, platformErrorText(e));
      else issues.failure(platformErrorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Байгууллага нэмэх" onClose={onClose}>
      <form ref={issues.formRef} onSubmit={(e) => void submit(e)} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">
          Байгууллагын нэр
          <input
            name="name"
            {...issues.flag("name")}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            maxLength={120}
            autoComplete="off"
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Байгууллагын код (нэвтрэхэд бичнэ)
          <input
            name="code"
            {...issues.flag("code")}
            value={form.code}
            onChange={(e) => set({ code: e.target.value })}
            maxLength={32}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            className={fieldClass}
          />
          <span className="mt-1 block text-xs font-normal text-slate-600">
            Жижиг латин үсэг, тоо, зураас. Дараа нь солихгүй. Жишээ: 311
          </span>
        </label>
        <label className="block text-sm font-medium">
          Цагийн бүс
          <input
            name="timeZone"
            {...issues.flag("timeZone")}
            value={form.timeZone}
            onChange={(e) => set({ timeZone: e.target.value })}
            autoCapitalize="none"
            autoComplete="off"
            className={fieldClass}
          />
        </label>
        <p className="text-sm font-medium">Анхны Байгууллагын админ</p>
        <label className="block text-sm font-medium">
          Нэр
          <input
            name="adminDisplayName"
            {...issues.flag("adminDisplayName")}
            value={form.adminDisplayName}
            onChange={(e) => set({ adminDisplayName: e.target.value })}
            maxLength={120}
            autoComplete="off"
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Нэвтрэх нэр
          <input
            name="adminUsername"
            {...issues.flag("adminUsername")}
            value={form.adminUsername}
            onChange={(e) => set({ adminUsername: e.target.value })}
            maxLength={64}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            className={fieldClass}
          />
        </label>
        <p className="text-sm text-slate-600">
          Үүсгэсний дараа нэг удаагийн нууц үг гарна. Админ эхний нэвтрэлтээр шинэ нууц үг сонгож,
          authenticator апп тохируулна. Ажлын цаг, шалтгаан зэрэг үндсэн тохиргоо автоматаар бэлэн
          болно.
        </p>
        <FormError id={issues.errorId} message={issues.message} className="text-sm text-red-700" />
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" disabled={busy} className={primaryButton}>
            Үүсгэх
          </button>
        </div>
      </form>
    </Modal>
  );
}
