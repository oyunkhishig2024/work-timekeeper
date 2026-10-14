"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { currentRequires, logout, type SessionUser } from "@/lib/session";
import { useSession } from "./use-session";

/** The menu entries. */
const PAGES: Array<[href: string, label: string]> = [
  ["/dashboard", "Хянах самбар"],
  ["/daily", "Өдрийн ирц"],
  ["/employees", "Ажилтнууд"],
  ["/schedule", "Цагийн хуваарь"],
  ["/locations", "Салбар, хэлтэс"],
  ["/reports", "Тайлан"],
  ["/review", "Хяналт"],
  ["/notifications", "Мэдэгдэл"],
];

/** The review lists share one menu entry. */
const active = (pathname: string, href: string) =>
  href === "/review"
    ? pathname === "/review" || pathname === "/device-alerts"
    : href === "/employees"
      ? pathname.startsWith("/employees")
      : pathname === href;

/** Page frame for signed-in pages: sends visitors without a session to the sign-in page. */
export function AppShell({ children }: { children: (user: SessionUser) => ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (session.status === "out") router.replace("/login");
    else if (session.status === "in" && currentRequires().length > 0) router.replace("/setup");
  }, [session.status, router]);

  if (session.status !== "in" || currentRequires().length > 0) {
    return <p className="p-8 text-slate-600">Ачаалж байна…</p>;
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-3 focus:font-medium focus:shadow-lg"
      >
        Үндсэн агуулга руу очих
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold">Timekeeper Work</span>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {session.user.displayName ?? session.user.username}
            </span>
            <button
              type="button"
              className="min-h-11 min-w-11 rounded-md border border-slate-300 px-3 font-medium hover:bg-slate-100"
              onClick={() => void logout().then(() => router.replace("/login"))}
            >
              Гарах
            </button>
          </div>
        </div>
      </header>
      <nav aria-label="Үндсэн цэс" className="border-b border-slate-200 bg-white">
        <ul className="mx-auto flex max-w-5xl flex-wrap gap-x-1 px-4">
          {PAGES.filter(([href]) => href !== "/locations" || session.user.role === "ORG_ADMIN").map(
            ([href, label]) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active(pathname, href) ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${
                    pathname === href
                      ? "border-teal-700 text-teal-800"
                      : "border-transparent text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {label}
                </Link>
              </li>
            ),
          )}
        </ul>
      </nav>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-6 focus:outline-none">
        {children(session.user)}
      </main>
    </div>
  );
}
