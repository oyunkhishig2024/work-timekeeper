"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import { changePassword, currentRequires, logout, totpEnable, totpSetup } from "@/lib/session";
import { useSession } from "@/components/use-session";
import { FormError } from "@/components/form-error";

const field = "mt-1 block min-h-11 w-full rounded-md border border-slate-300 px-3 text-base";
const primary =
  "min-h-11 w-full rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-60";

const REASONS: Record<string, string> = {
  TOO_SHORT: "Хамгийн багадаа 10 тэмдэгт байна.",
  TOO_COMMON: "Хэт түгээмэл нууц үг байна.",
  CONTAINS_USERNAME: "Нууц үг нэвтрэх нэрийг агуулж болохгүй.",
  REPEATED_CHARACTER: "Нэг тэмдэгтийг давтаж болохгүй.",
  SAME_AS_CURRENT: "Шинэ нууц үг түр нууц үгтэй адил байж болохгүй.",
};

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const reasons = (error.extra as { reasons?: string[] } | null)?.reasons;
    if (error.code === "WEAK_PASSWORD" && reasons?.length) {
      return reasons.map((r) => REASONS[r] ?? r).join(" ");
    }
    if (error.code === "INVALID_CREDENTIALS") return "Одоогийн нууц үг буруу байна.";
    if (error.code === "INVALID_CODE" || error.code === "INVALID_TOTP") {
      return "Код буруу байна. Апп дээрх шинэ кодоор дахин оролдоно уу.";
    }
    return error.message;
  }
  return "Холбогдож чадсангүй. Дахин оролдоно уу.";
}

/** First sign-in: replace the temporary password, then enrol the authenticator app (Org Admin and HR). */
export default function SetupPage() {
  const router = useRouter();
  const session = useSession();
  const [step, setStep] = useState<"password" | "totp" | "codes">("password");
  const [seed, setSeed] = useState<{ secret: string; qr: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session.status === "out") router.replace("/login");
  }, [session.status, router]);

  // Pick the step the account is on (also after a reload).
  useEffect(() => {
    if (session.status !== "in" || step === "codes") return;
    const need = currentRequires();
    if (need.includes("PASSWORD_CHANGE")) setStep("password");
    else if (need.includes("TOTP_SETUP")) setStep("totp");
    else router.replace("/dashboard");
  }, [session, step, router]);

  useEffect(() => {
    if (step !== "totp" || seed) return;
    void (async () => {
      try {
        const res = await totpSetup();
        setSeed({ secret: res.secret, qr: await QRCode.toDataURL(res.otpauthUri, { width: 220 }) });
      } catch (e) {
        setError(messageOf(e));
      }
    })();
  }, [step, seed]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const onPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = String(form.get("next"));
    if (next !== String(form.get("again"))) {
      setError("Шинэ нууц үг хоёр удаа таарахгүй байна.");
      return;
    }
    void run(async () => {
      await changePassword(String(form.get("current")), next);
      if (currentRequires().includes("TOTP_SETUP")) setStep("totp");
      else router.replace("/dashboard");
    });
  };

  const onCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code"));
    void run(async () => {
      setRecovery(await totpEnable(code));
      setStep("codes");
    });
  };

  if (session.status !== "in") return <p className="p-8 text-slate-600">Ачаалж байна…</p>;

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Бүртгэлээ бэлтгэх</h1>

      {step === "password" && (
        <form onSubmit={onPassword} className="mt-6 space-y-4">
          <p className="text-sm text-slate-600">
            Анх нэвтэрч байна. Түр нууц үгээ өөрийн нууц үгээр солино уу (10-аас дээш тэмдэгт).
          </p>
          <label className="block text-sm font-medium">
            Түр нууц үг
            <input
              name="current"
              type="password"
              required
              autoComplete="current-password"
              className={field}
            />
          </label>
          <label className="block text-sm font-medium">
            Шинэ нууц үг
            <input
              name="next"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className={field}
            />
          </label>
          <label className="block text-sm font-medium">
            Шинэ нууц үг дахин
            <input
              name="again"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className={field}
            />
          </label>
          <FormError message={error} className="text-sm text-red-700" />
          <button type="submit" disabled={busy} className={primary}>
            Нууц үг солих
          </button>
        </form>
      )}

      {step === "totp" && (
        <form onSubmit={onCode} className="mt-6 space-y-4">
          <p className="text-sm text-slate-600">
            Утсандаа Google Authenticator (эсвэл ижил апп) суулгаад доорх QR кодыг уншуулна уу.
            Дараа нь апп дээр гарч ирсэн 6 оронтой кодыг оруулна уу.
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
            !error && <p className="text-sm text-slate-500">Ачаалж байна…</p>
          )}
          <label className="block text-sm font-medium">
            Апп дээрх 6 оронтой код
            <input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              className={field}
            />
          </label>
          <FormError message={error} className="text-sm text-red-700" />
          <button type="submit" disabled={busy || !seed} className={primary}>
            Баталгаажуулах
          </button>
        </form>
      )}

      {step === "codes" && (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-slate-600">
            Утсаа алдвал эдгээр нөөц кодоор нэвтэрнэ. Нэг код нэг удаа хүчинтэй.{" "}
            <strong>Зөвхөн одоо харагдана</strong>: хуулж аюулгүй газар хадгална уу.
          </p>
          <ul className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-3 font-mono text-sm">
            {recovery.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <button type="button" className={primary} onClick={() => router.replace("/dashboard")}>
            Хадгалсан, үргэлжлүүлэх
          </button>
        </div>
      )}

      <button
        type="button"
        className="mt-6 inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-slate-500 underline"
        onClick={() => void logout().then(() => router.replace("/login"))}
      >
        Гарах
      </button>
    </main>
  );
}
