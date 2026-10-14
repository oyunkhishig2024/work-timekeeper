"use client";

import { useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import { createUser, newUserIssue, userErrorText, type NewUserForm } from "@/lib/users";
import { FormError } from "../form-error";
import { EmployeePicker } from "./employee-picker";
import { Modal } from "../modal";
import { fieldClass, primaryButton, secondaryButton } from "../styles";
import { useFieldIssue } from "../use-field-issue";

/** Org Admin adds an HR or Manager account; the answer carries the one-time password. */
export function AddUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: {
    id: string;
    username: string;
    temporaryPassword: string;
    role: "HR" | "MANAGER" | "BOSS";
  }) => void;
}) {
  const [form, setForm] = useState<NewUserForm>({
    username: "",
    displayName: "",
    role: "HR",
    employeeId: null,
  });
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const issues = useFieldIssue("add-user-form");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const issue = newUserIssue(form);
    if (issue) return issues.issue(issue.field, issue.message);
    setBusy(true);
    issues.clear();
    try {
      const created = await createUser(form);
      onCreated({ ...created, role: form.role });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "USERNAME_TAKEN") {
        issues.issue("username", userErrorText(e));
      } else {
        issues.failure(userErrorText(e));
      }
      setBusy(false);
    }
  }

  return (
    <Modal title="Хэрэглэгч нэмэх" onClose={onClose}>
      <form ref={issues.formRef} onSubmit={(e) => void submit(e)} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">
          Нэр
          <input
            name="displayName"
            {...issues.flag("displayName")}
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            maxLength={120}
            autoComplete="off"
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Нэвтрэх нэр
          <input
            name="username"
            {...issues.flag("username")}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            maxLength={64}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            className={fieldClass}
          />
          <span className="mt-1 block text-xs font-normal text-slate-600">
            Латин үсэг, тоо, цэг, зураас. Жишээ: bat.erdene
          </span>
        </label>
        <label className="block text-sm font-medium">
          Үүрэг
          <select
            name="role"
            value={form.role}
            onChange={(e) => {
              setForm({ ...form, role: e.target.value as NewUserForm["role"], employeeId: null });
              setEmployeeName(null);
            }}
            className={fieldClass}
          >
            <option value="HR">Хүний нөөц — ажилтан, ирц, хуваарь удирдана</option>
            <option value="MANAGER">
              Менежер — хариуцсан хэлтсээ харна (зөвхөн харах), өөрийн ирц бүртгэгдэнэ
            </option>
            <option value="BOSS">
              Дарга — байгууллагыг бүхэлд нь харна (зөвхөн харах), ирц бүртгэгдэхгүй
            </option>
          </select>
        </label>
        {form.role === "MANAGER" && (
          <div>
            {employeeName && (
              <p className="mb-2 rounded-md bg-slate-100 p-2 text-sm">
                Ажилтан: <b>{employeeName}</b>
              </p>
            )}
            <EmployeePicker
              label="Менежерийн ажилтны бүртгэл (нэр эсвэл код)"
              buttonLabel="Сонгох"
              onPick={(e) => {
                setForm((f) => ({ ...f, employeeId: e.id }));
                setEmployeeName(`${e.fullName} (${e.employeeNo})`);
              }}
              onError={issues.failure}
              inputProps={{ name: "employee", ...issues.flag("employee") }}
            />
          </div>
        )}
        <p className="text-sm text-slate-600">
          {form.role === "HR"
            ? "Эхний нэвтрэлтээр шинэ нууц үг сонгож, authenticator апп тохируулна."
            : form.role === "BOSS"
              ? "Эхний нэвтрэлтээр шинэ нууц үг сонгож, authenticator апп тохируулна. Утас, ирцийн бүртгэл шаардлагагүй."
              : "Менежер өөрийн утсаа бүртгүүлж ирц, гарсан цагаа бүртгүүлнэ. Үүсгэсний дараа аль хэлтэс, салбарыг харахыг сонгоно."}
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
