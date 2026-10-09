import { ApiError, NetworkError, SessionEndedError } from "./errors";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Where the tokens live: the secure keystore on the phone (apps/mobile/README.md), a map in tests. */
export interface TokenStore {
  read(): Promise<Tokens | null>;
  write(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  role: "ORG_ADMIN" | "HR" | "MANAGER" | "EMPLOYEE";
}

export interface AuthResult extends Tokens {
  user: SessionUser;
  /** Steps still to finish before anything else works: `PASSWORD_CHANGE`, `TOTP_SETUP`. */
  requires: string[];
}

export type LoginResult =
  { status: "OK"; auth: AuthResult } | { status: "MFA_REQUIRED"; challengeToken: string };

export interface ClientOptions {
  baseUrl: string;
  tokens: TokenStore;
  fetchImpl?: typeof fetch;
  /** Called when the session ended for good (the refresh token was refused). */
  onSessionEnded?: () => void;
  appVersion?: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** false: no bearer token (login, refresh). */
  auth?: boolean;
}

/**
 * The API client of the phone. It adds the bearer token, renews it once when the server answers 401 (a single refresh at a time, even
 * when several calls fail together, because the refresh token rotates and a replay would end the session), and turns problem+json
 * answers into `ApiError`. No network is a `NetworkError`, which callers treat as "try again later".
 */
export class ApiClient {
  private refreshing: Promise<Tokens> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const useAuth = opts.auth !== false;
    let tokens = useAuth ? await this.options.tokens.read() : null;
    if (useAuth && !tokens) throw new SessionEndedError();

    let res = await this.send(path, opts, tokens?.accessToken);
    if (res.status === 401 && useAuth && tokens) {
      tokens = await this.refresh(tokens);
      res = await this.send(path, opts, tokens.accessToken);
    }
    return this.parse<T>(res);
  }

  private async send(path: string, opts: RequestOptions, accessToken?: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (this.options.appVersion) headers["X-App-Version"] = this.options.appVersion;
    try {
      return await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch {
      throw new NetworkError();
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const p = (data ?? {}) as { code?: string; detail?: string } & Record<string, unknown>;
      const { code, detail, ...extra } = p;
      throw new ApiError(
        res.status,
        code ?? "REQUEST_FAILED",
        detail ?? `HTTP ${res.status}`,
        extra,
      );
    }
    return data as T;
  }

  /** One refresh at a time: the others wait for it. */
  private refresh(stale: Tokens): Promise<Tokens> {
    this.refreshing ??= this.doRefresh(stale).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(stale: Tokens): Promise<Tokens> {
    // Another call may have renewed already while this one was in flight.
    const current = await this.options.tokens.read();
    if (current && current.accessToken !== stale.accessToken) return current;
    // no network here is a NetworkError and the session is not over: the caller retries later
    const res = await this.send("/v1/auth/refresh", {
      method: "POST",
      body: { refreshToken: stale.refreshToken },
      auth: false,
    });
    if (!res.ok) {
      // 401 / 403 / 423: the refresh token is refused. A server error is not the end of the session.
      if (res.status >= 500) throw new ApiError(res.status, "SERVER_ERROR", `HTTP ${res.status}`);
      await this.options.tokens.clear();
      this.options.onSessionEnded?.();
      throw new SessionEndedError();
    }
    const body = (await res.json()) as AuthResult;
    const next = { accessToken: body.accessToken, refreshToken: body.refreshToken };
    await this.options.tokens.write(next);
    return next;
  }

  // ------------------------------------------------------------------ auth (apps/api/src/auth/README.md)

  async login(orgCode: string, username: string, password: string): Promise<LoginResult> {
    const body = await this.request<
      { status: "OK"; tokens: AuthResult } | { status: "MFA_REQUIRED"; challengeToken: string }
    >("/v1/auth/login", { method: "POST", body: { orgCode, username, password }, auth: false });
    if (body.status === "MFA_REQUIRED") return body;
    await this.options.tokens.write(pick(body.tokens));
    return { status: "OK", auth: body.tokens };
  }

  async verifyTotp(challengeToken: string, code: string): Promise<AuthResult> {
    const isRecovery = !/^\d{6}$/.test(code);
    const tokens = await this.request<AuthResult>("/v1/auth/totp/verify", {
      method: "POST",
      body: isRecovery ? { challengeToken, recoveryCode: code } : { challengeToken, code },
      auth: false,
    });
    await this.options.tokens.write(pick(tokens));
    return tokens;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<AuthResult> {
    const tokens = await this.request<AuthResult>("/v1/auth/password/change", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
    await this.options.tokens.write(pick(tokens));
    return tokens;
  }

  async logout(): Promise<void> {
    try {
      await this.request("/v1/auth/logout", { method: "POST" });
    } catch {
      // signing out works offline too: the tokens are dropped either way
    }
    await this.options.tokens.clear();
  }

  me() {
    return this.request<SessionUser & { totpEnabled: boolean; requires: string[] }>("/v1/auth/me");
  }

  // ------------------------------------------------------------------ the employee's phone

  myDevice() {
    return this.request<DeviceState>("/v1/devices/me");
  }

  registerDevice(input: RegisterInput) {
    return this.request<unknown>("/v1/devices/register", { method: "POST", body: input });
  }

  postEvents(events: ApiEvent[]) {
    return this.request<{ received: number; results: EventResult[] }>("/v1/events", {
      method: "POST",
      body: { events },
    });
  }

  heartbeat() {
    return this.request<{ serverTime: string }>("/v1/heartbeat", { method: "POST" });
  }

  plan() {
    return this.request<Plan>("/v1/mobile/plan");
  }

  myAttendance(from: string, to: string) {
    return this.request<MyAttendance>(`/v1/me/attendance?from=${from}&to=${to}`);
  }
}

const pick = (t: AuthResult): Tokens => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
});

export interface DeviceState {
  device: { id: string; status: string; platform: string; model: string | null } | null;
  consent: { status: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface RegisterInput {
  qrToken: string;
  platform: "ANDROID" | "IOS";
  model?: string;
  osVersion?: string;
  appVersion?: string;
  attestationKeyId?: string;
  publicKey?: string;
  attestationToken?: string;
}

/** An event as the server takes it (apps/api/src/attendance/attendance.controller.ts). */
export interface ApiEvent {
  clientEventId: string;
  type: "ENTER" | "EXIT";
  locationId: string;
  /** How long ago it happened: the server works out the time as "now minus this" (PRD 6.8). */
  ageMs: number;
  deviceTime?: string;
  accuracyM?: number;
  mockLocation?: boolean;
  lat?: number;
  lng?: number;
}

export type EventResult =
  | {
      clientEventId: string;
      outcome: "ACCEPTED";
      occurredAt: string;
      counted: boolean;
      flags: string[];
    }
  | { clientEventId: string; outcome: "DUPLICATE" }
  | { clientEventId: string; outcome: "REJECTED"; code: string };

export interface PlanPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export type PlanDay =
  | { date: string; expected: false; reason: string }
  | {
      date: string;
      expected: true;
      start: string;
      end: string;
      locations: Array<PlanPlace & { main: boolean }>;
    };

export interface Plan {
  generatedAt: string;
  timeZone: string;
  days: PlanDay[];
  places: PlanPlace[];
}

export interface MyDay {
  date: string;
  status:
    "ON_TIME" | "LATE" | "EXCUSED" | "NO_SHOW" | "PENDING" | "WORKED_OFF_DAY" | "NOT_CONFIGURED";
  arrivalAt: string | null;
  lateMinutes: number;
  reasonName: string | null;
  departureAt: string | null;
  departureState: "LEFT" | "INSIDE" | "UNKNOWN" | null;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
}

export interface MyAttendance {
  from: string;
  to: string;
  summary: {
    onTime: number;
    late: number;
    noShow: number;
    excused: number;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    shortMinutes: number;
    overtimeMinutes: number;
  };
  items: MyDay[];
}
