import type { TokenStore, Tokens } from "../src/lib/api";
import type { KeyValueStore } from "../src/services/outbox";

export class MemoryTokens implements TokenStore {
  constructor(public value: Tokens | null = null) {}
  async read() {
    return this.value;
  }
  async write(t: Tokens) {
    this.value = t;
  }
  async clear() {
    this.value = null;
  }
}

export class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  async getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  async setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  async removeItem(k: string) {
    this.data.delete(k);
  }
}

export interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

/** A fake `fetch`: the handler answers [status, json] for each call; every call is recorded. */
export function fakeFetch(handler: (call: Call, n: number) => [number, unknown] | "network") {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url).replace("http://api", ""),
      method: init?.method ?? "GET",
      auth: headers.Authorization ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = handler(call, calls.length);
    if (out === "network") throw new TypeError("Network request failed");
    const [status, body] = out;
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
