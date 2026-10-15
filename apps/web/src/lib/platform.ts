import { ApiRequestError } from "./api";

/**
 * Client of the Super Admin API (/v1/platform). Kept apart from the staff session on purpose: its own token (a different
 * audience on the server), its own storage key, no refresh. A session lasts what the server says (`expiresIn`), then the Super
 * Admin signs in again. The token is kept in sessionStorage, so a reload keeps the session and closing the tab ends it.
 */

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string | null;
}

interface PlatformTokens {
  accessToken: string;
  expiresIn: number;
  user: PlatformUser;
  requires: string[];
}

interface Stored {
  token: string;
  expiresAt: number;
  user: PlatformUser;
  requires: string[];
}

const KEY = "tk.platform";
let current: Stored | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function accept(tokens: PlatformTokens): void {
  current = {
    token: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    user: tokens.user,
    requires: tokens.requires,
  };
  storage()?.setItem(KEY, JSON.stringify(current));
  emit();
}

function clear(): void {
  current = null;
  storage()?.removeItem(KEY);
  emit();
}

export function subscribePlatform(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session of this tab (restored after a reload), or null when there is none or it ran out. */
export function platformSession(): { user: PlatformUser; requires: string[] } | null {
  if (!current) {
    try {
      const raw = storage()?.getItem(KEY);
      if (raw) current = JSON.parse(raw) as Stored;
    } catch {
      current = null;
    }
  }
  if (current && current.expiresAt <= Date.now()) clear();
  return current ? { user: current.user, requires: current.requires } : null;
}

async function call<T>(
  path: string,
  opts: { method?: "GET" | "POST" | "PATCH"; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth !== false && current) headers.Authorization = `Bearer ${current.token}`;
  const res = await fetch(`/v1/platform/${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const problem = (data ?? {}) as { code?: string; detail?: string };
    // A refused token ends the session; a wrong password or code does not.
    if (res.status === 401 && opts.auth !== false && problem.code === "UNAUTHENTICATED") clear();
    throw new ApiRequestError(
      res.status,
      problem.code ?? "REQUEST_FAILED",
      problem.detail ?? `Request failed (${res.status})`,
      data,
    );
  }
  return data as T;
}

// ---------------------------------------------------------------- sign-in

export type PlatformLogin = { kind: "SIGNED_IN" } | { kind: "MFA"; challengeToken: string };

export async function platformLogin(username: string, password: string): Promise<PlatformLogin> {
  const res = await call<
    { status: "MFA_REQUIRED"; challengeToken: string } | { status: "OK"; tokens: PlatformTokens }
  >("auth/login", { method: "POST", body: { username, password }, auth: false });
  if (res.status === "MFA_REQUIRED") return { kind: "MFA", challengeToken: res.challengeToken };
  accept(res.tokens);
  return { kind: "SIGNED_IN" };
}

export async function platformVerify(challengeToken: string, code: string): Promise<void> {
  accept(
    await call<PlatformTokens>("auth/totp/verify", {
      method: "POST",
      body: { challengeToken, code },
      auth: false,
    }),
  );
}

export async function platformLogout(): Promise<void> {
  try {
    await call("auth/logout", { method: "POST" });
  } catch {
    // dropped locally either way
  }
  clear();
}

export async function platformChangePassword(currentPassword: string, newPassword: string) {
  accept(
    await call<PlatformTokens>("auth/password/change", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
  );
}

export const platformTotpSetup = () =>
  call<{ secret: string; otpauthUri: string }>("auth/totp/setup", { method: "POST" });

export async function platformTotpEnable(code: string): Promise<void> {
  accept(await call<PlatformTokens>("auth/totp/enable", { method: "POST", body: { code } }));
}

// ---------------------------------------------------------------- organizations

export interface Tenant {
  id: string;
  code: string;
  name: string;
  timeZone: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  employees: number;
  staffAccounts: number;
  lastLoginAt: string | null;
  lastEventAt: string | null;
}

export interface TenantAdmin {
  id: string;
  username: string;
  displayName: string | null;
  status: "ACTIVE" | "DISABLED";
  totpEnabled: boolean;
  lastLoginAt: string | null;
}

export type TenantDetail = Tenant & { admins: TenantAdmin[] };

export interface ActivityRow {
  id: string;
  occurredAt: string;
  action: string;
  actorRole: string | null;
  actorUsername: string | null;
  orgCode: string | null;
}

export interface NewTenantForm {
  code: string;
  name: string;
  timeZone: string;
  adminUsername: string;
  adminDisplayName: string;
}

export const fetchTenants = () => call<Tenant[]>("tenants");
export const fetchTenant = (id: string) => call<TenantDetail>(`tenants/${id}`);
export const createTenant = (form: NewTenantForm) =>
  call<{ tenant: TenantDetail; admin: { username: string; temporaryPassword: string } }>(
    "tenants",
    { method: "POST", body: form },
  );
export const renameTenant = (id: string, name: string) =>
  call<TenantDetail>(`tenants/${id}`, { method: "PATCH", body: { name } });
export const setTenantStatus = (id: string, status: "ACTIVE" | "SUSPENDED") =>
  call<TenantDetail>(`tenants/${id}/${status === "SUSPENDED" ? "suspend" : "activate"}`, {
    method: "POST",
  });
export const addTenantAdmin = (id: string, username: string, displayName: string) =>
  call<{ username: string; temporaryPassword: string }>(`tenants/${id}/admins`, {
    method: "POST",
    body: { username, displayName },
  });
export const resetTenantAdmin = (id: string, username: string, totp: boolean) =>
  call<{ username: string; temporaryPassword: string; totpRemoved: boolean }>(
    `tenants/${id}/admins/reset`,
    { method: "POST", body: { username, totp } },
  );
export const fetchActivity = () => call<ActivityRow[]>("activity?limit=100");

// ---------------------------------------------------------------- wording

const TEXT: Record<string, string> = {
  CODE_TAKEN: "Энэ байгууллагын код аль хэдийн ашиглагдаж байна.",
  CODE_RESERVED: "Энэ код захиалагдсан байна. Өөр код сонгоно уу.",
  INVALID_TIME_ZONE: "Цагийн бүс танигдсангүй.",
  USERNAME_TAKEN: "Энэ нэвтрэх нэр аль хэдийн ашиглагдаж байна.",
  NO_CHANGE: "Төлөв аль хэдийн ийм байна.",
  TENANT_NOT_FOUND: "Байгууллага олдсонгүй.",
  USER_NOT_FOUND: "Энэ нэртэй админ энэ байгууллагад алга.",
  INVALID_CREDENTIALS: "Нэвтрэх нэр эсвэл нууц үг буруу байна.",
  TEMP_PASSWORD_EXPIRED:
    "Нэг удаагийн нууц үгийн хугацаа (72 цаг) дууссан. Серверээс шинээр авна уу (--reset).",
  INVALID_CODE: "Код буруу байна. Апп дээрх шинэ кодоор дахин оролдоно уу.",
  ACCOUNT_LOCKED: "Олон удаа буруу оруулсан тул түр түгжигдлээ. Хэсэг хүлээгээд дахин оролдоно уу.",
};

export function platformErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) return TEXT[error.code] ?? error.message;
  return "Холбогдож чадсангүй. Дахин оролдоно уу.";
}

export const ACTION_TEXT: Record<string, string> = {
  "platform.login_success": "Нэвтэрсэн",
  "platform.login_failed": "Нэвтрэлт амжилтгүй",
  "platform.account_locked": "Бүртгэл түгжигдсэн",
  "platform.login_blocked": "Түгжээтэй бүртгэл нэвтрэхийг завдсан",
  "platform.logout": "Гарсан",
  "platform.password_changed": "Нууц үг солисон",
  "platform.totp_enabled": "Authenticator тохируулсан",
  "platform.totp_setup_started": "Authenticator тохиргоо эхэлсэн",
  "platform.user_created": "Super Admin үүсгэсэн (сервер)",
  "platform.user_reset": "Super Admin сэргээсэн (сервер)",
  "tenant.created": "Байгууллага үүсгэсэн",
  "tenant.renamed": "Байгууллагын нэр солисон",
  "tenant.suspended": "Байгууллагыг түдгэлзүүлсэн",
  "tenant.activated": "Байгууллагыг идэвхжүүлсэн",
  "user.created": "Байгууллагын админ нэмсэн",
  "user.password_reset": "Админы нууц үг сэргээсэн",
  "user.totp_reset": "Админы authenticator сэргээсэн",
};

/** A moment shown in Ulaanbaatar time, or a dash. */
export const dateText = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Ulaanbaatar" }).slice(0, 16) : "—";
