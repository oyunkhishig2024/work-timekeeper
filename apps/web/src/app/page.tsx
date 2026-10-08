"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** The front page is the dashboard; visitors without a session are sent on to the sign-in page from there. */
export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);
  return <p className="p-8 text-slate-600">Ачаалж байна…</p>;
}
