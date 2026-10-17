import { api, ApiRequestError, setTokenProvider } from "./api";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  role: "ORG_ADMIN" | "HR" | "MANAGER" | "BOSS" | "EMPLOYEE";
  /** Set while the password is a one-time one an admin issued: the role that did it and when. */
  passwordReset?: { at: string; by: string } | null;
}

interface Tokens {
  accessToken: string;
  user: SessionUser;
  requires?: string[];
}

type LoginResponse =
  { status: "MFA_REQUIRED"; challengeToken: string } | { status?: string; tokens: Tokens };

/** Not a secret: only says "this tab was signed in", so a page load without a sign-in does not call refresh for nothing. */
const SIGNED_IN_KEY = "tk.signed-in";
/** The refresh token used to live here; it is in an httpOnly cookie now. Removed from tabs that still have the old value. */
const LEGACY_REFRESH_KEY = "tk.refresh";

/**
 * Browser session. The short-lived access token lives only in memory. The refresh token is an httpOnly cookie the browser sends
 * to /v1/auth/refresh by itself: no page script can read it, so a script injected into a page cannot steal the long-lived
 * credential. A reload keeps you signed in (the cookie); the tab marker above is dropped when the tab closes.
 */
let accessToken: string | null = null;
let user: SessionUser | null = null;
let requires: string[] = [];
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const currentUser = (): SessionUser | null => user;

/** Setup steps the account must finish before the app works: "PASSWORD_CHANGE", "TOTP_SETUP". */
export const currentRequires = (): readonly string[] => requires;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

storage()?.removeItem(LEGACY_REFRESH_KEY);

function accept(tokens: Tokens): void {
  accessToken = tokens.accessToken;
  user = tokens.user;
  requires = tokens.requires ?? [];
  storage()?.setItem(SIGNED_IN_KEY, "1");
  emit();
}

function clear(): void {
  accessToken = null;
  user = null;
  requires = [];
  storage()?.removeItem(SIGNED_IN_KEY);
  emit();
}

async function refresh(): Promise<boolean> {
  // Several requests may fail at once; they share one refresh (refresh tokens rotate, a second use would end the session).
  refreshing ??= (async () => {
    if (!storage()?.getItem(SIGNED_IN_KEY)) return false;
    try {
      // No token in the request: the browser attaches the httpOnly cookie.
      accept(await api<Tokens>("/v1/auth/refresh", { method: "POST", auth: false }));
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

setTokenProvider({ accessToken: () => accessToken, refresh, expire: clear });

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

/** Required first-login step: replaces the temporary password. The old sessions end; a fresh one is kept. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  accept(
    await api<Tokens>("/v1/auth/password/change", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
  );
}

/** Starts authenticator-app enrolment; the seed stays inactive until a code from the app is confirmed. */
export function totpSetup(): Promise<{ secret: string; otpauthUri: string }> {
  return api("/v1/auth/totp/setup", { method: "POST" });
}

/** Confirms enrolment with a code; returns the one-time recovery codes. */
export async function totpEnable(code: string): Promise<string[]> {
  const res = await api<Tokens & { recoveryCodes: string[] }>("/v1/auth/totp/enable", {
    method: "POST",
    body: { code },
  });
  accept(res);
  return res.recoveryCodes;
}
