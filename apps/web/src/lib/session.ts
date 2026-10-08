import { api, ApiRequestError, setTokenProvider } from "./api";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  role: "ORG_ADMIN" | "HR" | "MANAGER" | "EMPLOYEE";
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
  requires?: string[];
}

type LoginResponse =
  { status: "MFA_REQUIRED"; challengeToken: string } | { status?: string; tokens: Tokens };

const REFRESH_KEY = "tk.refresh";

/**
 * Browser session. The short-lived access token lives only in memory; the refresh token is kept in sessionStorage, so a
 * reload keeps you signed in but closing the tab ends the session. (An httpOnly-cookie backend-for-frontend would keep the
 * refresh token away from page scripts entirely; that is a later hardening step.)
 */
let accessToken: string | null = null;
let user: SessionUser | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const currentUser = (): SessionUser | null => user;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function accept(tokens: Tokens): void {
  accessToken = tokens.accessToken;
  user = tokens.user;
  storage()?.setItem(REFRESH_KEY, tokens.refreshToken);
  emit();
}

function clear(): void {
  accessToken = null;
  user = null;
  storage()?.removeItem(REFRESH_KEY);
  emit();
}

async function refresh(): Promise<boolean> {
  // Several requests may fail at once; they share one refresh (refresh tokens rotate, a second use would end the session).
  refreshing ??= (async () => {
    const token = storage()?.getItem(REFRESH_KEY);
    if (!token) return false;
    try {
      accept(
        await api<Tokens>("/v1/auth/refresh", {
          method: "POST",
          body: { refreshToken: token },
          auth: false,
        }),
      );
      return true;
    } catch (error) {
      // Only a rejected token ends the session; a network error keeps it for the next try.
      if (error instanceof ApiRequestError && error.status < 500) clear();
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

setTokenProvider({ accessToken: () => accessToken, refresh });

/** On page load: continue the session of this tab, if any. */
export async function restoreSession(): Promise<SessionUser | null> {
  if (user) return user;
  await refresh();
  return user;
}

export type LoginResult =
  { kind: "SIGNED_IN"; user: SessionUser } | { kind: "MFA"; challengeToken: string };

export async function login(
  orgCode: string,
  username: string,
  password: string,
): Promise<LoginResult> {
  const res = await api<LoginResponse>("/v1/auth/login", {
    method: "POST",
    body: { orgCode, username, password },
    auth: false,
  });
  if (res.status === "MFA_REQUIRED" && "challengeToken" in res) {
    return { kind: "MFA", challengeToken: res.challengeToken };
  }
  if (!("tokens" in res))
    throw new ApiRequestError(500, "UNEXPECTED_RESPONSE", "Unexpected login response");
  accept(res.tokens);
  return { kind: "SIGNED_IN", user: res.tokens.user };
}

export async function verifyTotp(challengeToken: string, code: string): Promise<SessionUser> {
  const tokens = await api<Tokens>("/v1/auth/totp/verify", {
    method: "POST",
    body: { challengeToken, code },
    auth: false,
  });
  accept(tokens);
  return tokens.user;
}

export async function logout(): Promise<void> {
  try {
    await api("/v1/auth/logout", { method: "POST" });
  } catch {
    // the session is dropped locally either way
  }
  clear();
}
