"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import { login, verifyTotp } from "@/lib/session";
import { FormError } from "@/components/form-error";
import { PasswordField } from "@/components/password-field";
import { fieldClass, primaryButton } from "@/components/styles";
import { useFieldIssue } from "@/components/use-field-issue";

export default function LoginPage() {
  const router = useRouter();
  const [challenge, setChallenge] = useState<string | null>(null);
  const issues = useFieldIssue("login-form");
  const [busy, setBusy] = useState(false);

  /** `field` is the field a refusal is about: the server never says whether the name or the password was wrong. */
  async function run(field: string, action: () => Promise<void>) {
    setBusy(true);
    issues.clear();
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "TEMP_PASSWORD_EXPIRED") {
        issues.issue(
          field,
          "Энэ нэг удаагийн нууц үгийн хугацаа (72 цаг) дууссан. Админаасаа шинээр авна уу.",
        );
      } else if (e instanceof ApiRequestError) issues.issue(field, e.message);
      else issues.failure("Холбогдож чадсангүй. Дахин оролдоно уу.");
    } finally {
      setBusy(false);
    }
  }

  const onPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run("password", async () => {
      const result = await login(
        String(form.get("orgCode")),
        String(form.get("username")),
        String(form.get("password")),
      );
      if (result.kind === "MFA") setChallenge(result.challengeToken);
      else router.replace("/dashboard");
    });
  };

  const onCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code"));
    void run("code", async () => {
      await verifyTotp(challenge!, code);
      router.replace("/dashboard");
    });
  };

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Нэвтрэх</h1>
      {challenge === null ? (
        <form ref={issues.formRef} onSubmit={onPassword} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Байгууллагын код
            <input name="orgCode" required autoComplete="organization" className={fieldClass} />
          </label>
          <label className="block text-sm font-medium">
            Нэвтрэх нэр
            <input name="username" required autoComplete="username" className={fieldClass} />
          </label>
          <PasswordField
            label="Нууц үг"
            name="password"
            required
            autoComplete="current-password"
            {...issues.flag("password")}
          />
          <FormError id={issues.errorId} message={issues.message} />
          <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
            Үргэлжлүүлэх
          </button>
        </form>
      ) : (
        <form ref={issues.formRef} onSubmit={onCode} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Баталгаажуулах код (6 орон)
            <input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              {...issues.flag("code")}
              className={fieldClass}
            />
          </label>
          <FormError id={issues.errorId} message={issues.message} />
          <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
            Нэвтрэх
          </button>
        </form>
      )}
    </main>
  );
}
