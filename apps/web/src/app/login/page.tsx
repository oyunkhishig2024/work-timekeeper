"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import { login, verifyTotp } from "@/lib/session";

const field = "mt-1 block min-h-11 w-full rounded-md border border-slate-300 px-3 text-base";
const primary =
  "min-h-11 w-full rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-60";

export default function LoginPage() {
  const router = useRouter();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof ApiRequestError ? e.message : "Холбогдож чадсангүй. Дахин оролдоно уу.",
      );
    } finally {
      setBusy(false);
    }
  }

  const onPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      const result = await login(
        String(form.get("orgCode")),
        String(form.get("username")),
        String(form.get("password")),
      );
      if (result.kind === "MFA") setChallenge(result.challengeToken);
      else router.replace("/notifications");
    });
  };

  const onCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code"));
    void run(async () => {
      await verifyTotp(challenge!, code);
      router.replace("/notifications");
    });
  };

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Нэвтрэх</h1>
      {challenge === null ? (
        <form onSubmit={onPassword} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Байгууллагын код
            <input name="orgCode" required autoComplete="organization" className={field} />
          </label>
          <label className="block text-sm font-medium">
            Нэвтрэх нэр
            <input name="username" required autoComplete="username" className={field} />
          </label>
          <label className="block text-sm font-medium">
            Нууц үг
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={field}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className={primary}>
            Үргэлжлүүлэх
          </button>
        </form>
      ) : (
        <form onSubmit={onCode} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Баталгаажуулах код (6 орон)
            <input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              className={field}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className={primary}>
            Нэвтрэх
          </button>
        </form>
      )}
    </main>
  );
}
