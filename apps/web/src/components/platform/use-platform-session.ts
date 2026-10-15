"use client";

import { useEffect, useState } from "react";
import { platformSession, subscribePlatform, type PlatformUser } from "@/lib/platform";

export type PlatformState =
  | { status: "loading" }
  | { status: "out" }
  | { status: "in"; user: PlatformUser; requires: string[] };

/** The Super Admin session of this tab (restored from sessionStorage after a reload). */
export function usePlatformSession(): PlatformState {
  const [state, setState] = useState<PlatformState>({ status: "loading" });
  useEffect(() => {
    const apply = () => {
      const s = platformSession();
      setState(s ? { status: "in", user: s.user, requires: s.requires } : { status: "out" });
    };
    apply();
    return subscribePlatform(apply);
  }, []);
  return state;
}
