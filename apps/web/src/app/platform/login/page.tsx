"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import { platformErrorText, platformLogin, platformSession, platformVerify } from "@/lib/platform";
import { FormError } from "@/components/form-error";
import { PasswordField } from "@/components/password-field";
import { fieldClass, primaryButton } from "@/components/styles";
import { useFieldIssue } from "@/components/use-field-issue";

/** Sign-in of the platform owner (Super Admin): username and password, then the authenticator code. */
export default function PlatformLoginPage() {
  const router = useRouter();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const issues = useFieldIssue("platform-login-form");

  async function run(field: string, action: () => Promise<void>) {
    setBusy(true);
    issues.clear();
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiRequestError) issues.issue(field, platformErrorText(e));
      else issues.failure(platformErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  const done = () => {
    const s = platformSession();
    router.replace(s && s.requires.length > 0 ? "/platform/setup" : "/platform");
  };

  const onPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run("password", async () => {
      const result = await platformLogin(
        String(form.get("username")),
        String(form.get("password")),
      );
      if (result.kind === "MFA") setChallenge(result.challengeToken);
      else done();
    });
  };

  const onCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code"));
    void run("code", async () => {
      await platformVerify(challenge!, code);
      done();
    });
  };

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Платформ — нэвтрэх</h1>
      {challenge === null ? (
        <form ref={issues.formRef} onSubmit={onPassword} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Нэвтрэх нэр
            <input
              name="username"
              required
              autoComplete="username"
              autoCapitalize="none"
              className={fieldClass}
            />
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
            Authenticator апп дээрх 6 оронтой код
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
