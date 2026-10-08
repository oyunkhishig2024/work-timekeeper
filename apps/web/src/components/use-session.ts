"use client";

import { useEffect, useState } from "react";
import { currentUser, restoreSession, subscribeSession, type SessionUser } from "@/lib/session";

export type SessionState =
  { status: "loading" } | { status: "out" } | { status: "in"; user: SessionUser };

/** The signed-in user of this tab; restores the session after a reload. */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    const apply = () => {
      const user = currentUser();
      if (alive) setState(user ? { status: "in", user } : { status: "out" });
    };
    const unsubscribe = subscribeSession(apply);
    void restoreSession().then(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return state;
}
