"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { logout, type SessionUser } from "@/lib/session";
import { useSession } from "./use-session";

/** Page frame for signed-in pages: sends visitors without a session to the sign-in page. */
export function AppShell({ children }: { children: (user: SessionUser) => ReactNode }) {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session.status === "out") router.replace("/login");
  }, [session.status, router]);

  if (session.status !== "in") {
    return <p className="p-8 text-slate-600">Ачаалж байна…</p>;
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold">Timekeeper Work</span>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {session.user.displayName ?? session.user.username}
            </span>
            <button
              type="button"
              className="min-h-11 rounded-md border border-slate-300 px-3 font-medium hover:bg-slate-100"
              onClick={() => void logout().then(() => router.replace("/login"))}
            >
              Гарах
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children(session.user)}</main>
    </div>
  );
}
