"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import {
  platformChangePassword,
  platformErrorText,
  platformLogout,
  platformSession,
  platformTotpEnable,
  platformTotpSetup,
} from "@/lib/platform";
import { usePlatformSession } from "@/components/platform/use-platform-session";
import { FormError } from "@/components/form-error";
import { PasswordField } from "@/components/password-field";
import { fieldClass, primaryButton } from "@/components/styles";
import { useFieldIssue } from "@/components/use-field-issue";

const WEAK: Record<string, string> = {
  TOO_SHORT: "Хамгийн багадаа 10 тэмдэгт байна.",
  TOO_COMMON: "Хэт түгээмэл нууц үг байна.",
  CONTAINS_USERNAME: "Нууц үг нэвтрэх нэрийг агуулж болохгүй.",
  REPEATED_CHARACTER: "Нэг тэмдэгтийг давтаж болохгүй.",
  SAME_AS_CURRENT: "Шинэ нууц үг түр нууц үгтэй адил байж болохгүй.",
};

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError && error.code === "WEAK_PASSWORD") {
    const reasons = (error.extra as { reasons?: string[] } | null)?.reasons ?? [];
    if (reasons.length) return reasons.map((r) => WEAK[r] ?? r).join(" ");
  }
  if (error instanceof ApiRequestError && error.code === "INVALID_CREDENTIALS") {
    return "Одоогийн нууц үг буруу байна.";
  }
  return platformErrorText(error);
}

function fieldOf(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === "WEAK_PASSWORD") return "next";
  if (error.code === "INVALID_CREDENTIALS") return "current";
  if (error.code === "INVALID_CODE") return "code";
  return null;
}

/** First sign-in of the Super Admin: a new password, then the authenticator app (mandatory). */
export default function PlatformSetupPage() {
  const router = useRouter();
  const session = usePlatformSession();
  const [step, setStep] = useState<"password" | "totp">("password");
  const [seed, setSeed] = useState<{ secret: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const issues = useFieldIssue("platform-setup-form");

  useEffect(() => {
    if (session.status === "out") router.replace("/platform/login");
    if (session.status !== "in") return;
    if (session.requires.includes("PASSWORD_CHANGE")) setStep("password");
    else if (session.requires.includes("TOTP_SETUP")) setStep("totp");
    else router.replace("/platform");
  }, [session, router]);

  useEffect(() => {
    if (step !== "totp" || seed) return;
    void (async () => {
      try {
        const res = await platformTotpSetup();
        setSeed({ secret: res.secret, qr: await QRCode.toDataURL(res.otpauthUri, { width: 220 }) });
      } catch (e) {
        issues.failure(messageOf(e));
      }
    })();
  }, [step, seed]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    issues.clear();
    try {
      await action();
    } catch (e) {
      const name = fieldOf(e);
      if (name) issues.issue(name, messageOf(e));
      else issues.failure(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const onPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = String(form.get("next"));
    if (next !== String(form.get("again"))) {
      issues.issue("again", "Шинэ нууц үг хоёр удаа таарахгүй байна.");
      return;
    }
    void run(async () => {
      await platformChangePassword(String(form.get("current")), next);
      if (platformSession()?.requires.includes("TOTP_SETUP")) setStep("totp");
      else router.replace("/platform");
    });
  };

  const onCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code"));
    void run(async () => {
      await platformTotpEnable(code);
      router.replace("/platform");
    });
  };

  if (session.status !== "in") return <p className="p-8 text-slate-600">Ачаалж байна…</p>;

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Бүртгэлээ бэлтгэх</h1>
      {step === "password" ? (
        <form ref={issues.formRef} onSubmit={onPassword} className="mt-6 space-y-4">
          <p className="text-sm text-slate-600">
            Түр нууц үгээ өөрийн нууц үгээр солино уу (10-аас дээш тэмдэгт).
          </p>
          <PasswordField
            label="Түр нууц үг"
            name="current"
            required
            autoComplete="current-password"
            {...issues.flag("current")}
          />
          <PasswordField
            label="Шинэ нууц үг"
            name="next"
            required
            minLength={10}
            autoComplete="new-password"
            {...issues.flag("next")}
          />
          <PasswordField
            label="Шинэ нууц үг дахин"
            name="again"
            required
            minLength={10}
            autoComplete="new-password"
            {...issues.flag("again")}
          />
          <FormError id={issues.errorId} message={issues.message} />
          <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
            Нууц үг солих
          </button>
        </form>
      ) : (
        <form ref={issues.formRef} onSubmit={onCode} className="mt-6 space-y-4">
          <p className="text-sm text-slate-600">
            Утсандаа Google Authenticator (эсвэл ижил апп) суулгаад QR кодыг уншуулна уу. Утсаа
            алдвал сервер дээрээс сэргээнэ (docs/operations/platform-admin.md).
          </p>
          {seed ? (
            <div className="flex flex-col items-center gap-2">
              <img src={seed.qr} alt="Баталгаажуулах QR код" width={220} height={220} />
              <p className="text-xs text-slate-500">
                QR уншихгүй бол энэ түлхүүрийг гараар оруулна уу:
              </p>
              <code className="break-all text-sm">{seed.secret}</code>
            </div>
          ) : (
            !issues.message && <p className="text-sm text-slate-500">Ачаалж байна…</p>
          )}
          <label className="block text-sm font-medium">
            Апп дээрх 6 оронтой код
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
          <button type="submit" disabled={busy || !seed} className={`${primaryButton} w-full`}>
            Баталгаажуулах
          </button>
        </form>
      )}
      <button
        type="button"
        className="mt-6 inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-slate-500 underline"
        onClick={() => void platformLogout().then(() => router.replace("/platform/login"))}
      >
        Гарах
      </button>
    </main>
  );
}
