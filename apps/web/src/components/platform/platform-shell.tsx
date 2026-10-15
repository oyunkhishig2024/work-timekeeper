"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { platformLogout, type PlatformUser } from "@/lib/platform";
import { smallButton } from "../styles";
import { usePlatformSession } from "./use-platform-session";

/** Frame of the Super Admin pages: sends visitors without a session to the platform sign-in. */
export function PlatformShell({ children }: { children: (user: PlatformUser) => ReactNode }) {
  const session = usePlatformSession();
  const router = useRouter();
  useEffect(() => {
    if (session.status === "out") router.replace("/platform/login");
    else if (session.status === "in" && session.requires.length > 0)
      router.replace("/platform/setup");
  }, [session, router]);

  if (session.status !== "in" || session.requires.length > 0) {
    return <p className="p-8 text-slate-600">Ачаалж байна…</p>;
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold">Timekeeper Work · Платформ</span>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {session.user.displayName ?? session.user.username}
            </span>
            <button
              type="button"
              className={`${smallButton} min-w-11`}
              onClick={() => void platformLogout().then(() => router.replace("/platform/login"))}
            >
              Гарах
            </button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-6 focus:outline-none">
        {children(session.user)}
      </main>
    </div>
  );
}
