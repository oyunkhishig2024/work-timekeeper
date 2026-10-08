/** Thin client for the Timekeeper API. Same origin: /v1/* is forwarded to the API (see next.config.ts). */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra data of the problem (an import's report when it was refused). */
    readonly extra?: unknown,
  ) {
    super(message);
  }
}

type TokenProvider = {
  accessToken(): string | null;
  /** Gets a new access token with the refresh token; false when the session is over. */
  refresh(): Promise<boolean>;
};

let provider: TokenProvider | null = null;

export function setTokenProvider(p: TokenProvider): void {
  provider = p;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Public endpoints (login) are called without a token and never refreshed. */
  auth?: boolean;
}

async function once(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = opts.auth === false ? null : (provider?.accessToken() ?? null);
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
  });
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await once(path, opts);
  // An expired access token is renewed once, transparently; a second 401 means the session is over.
  if (res.status === 401 && opts.auth !== false && provider && (await provider.refresh())) {
    res = await once(path, opts);
  }
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const problem = (data ?? {}) as { code?: string; detail?: string };
    throw new ApiRequestError(
      res.status,
      problem.code ?? "REQUEST_FAILED",
      problem.detail ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Downloads a file the API generates (exports). The token goes in the header, so a plain link cannot be used. */
export async function download(path: string): Promise<{ blob: Blob; fileName: string }> {
  const send = () => {
    const token = provider?.accessToken() ?? null;
    return fetch(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    });
  };
  let res = await send();
  if (res.status === 401 && provider && (await provider.refresh())) res = await send();
  if (!res.ok) {
    const problem = (safeJson(await res.text()) ?? {}) as { code?: string; detail?: string };
    throw new ApiRequestError(
      res.status,
      problem.code ?? "REQUEST_FAILED",
      problem.detail ?? `Request failed (${res.status})`,
    );
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/iu.exec(disposition);
  return { blob: await res.blob(), fileName: match ? decodeURIComponent(match[1]!) : "export" };
}

/** Sends a file as the raw request body (imports); the API reads .xlsx or CSV from the content, not from the name. */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const send = () => {
    const token = provider?.accessToken() ?? null;
    return fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
      cache: "no-store",
    });
  };
  let res = await send();
  if (res.status === 401 && provider && (await provider.refresh())) res = await send();
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const problem = (data ?? {}) as { code?: string; detail?: string; report?: unknown };
    throw new ApiRequestError(
      res.status,
      problem.code ?? "REQUEST_FAILED",
      problem.detail ?? `Request failed (${res.status})`,
      problem.report,
    );
  }
  return data as T;
}
