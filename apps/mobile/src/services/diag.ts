import type { KeyValueStore } from "./outbox";

export interface DiagEntry {
  /** Epoch ms on the phone. */
  t: number;
  m: string;
}

const KEY = "diag.v1";
export const MAX_DIAG = 80;

/**
 * A small log kept on the phone (the last `MAX_DIAG` lines) so what the app did in the background can be read on the phone's
 * "Утас" tab: app starts, plan loads, geofence events, uploads, sign-outs. It holds no personal data (no coordinates, no names of
 * people). Like the outbox it changes the list inside one promise chain, so two writers cannot lose a line.
 */
export class DiagLog {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  log(message: string): Promise<void> {
    const entry: DiagEntry = { t: this.now(), m: message.slice(0, 200) };
    const next = this.chain.then(async () => {
      const list = await this.readNow();
      list.push(entry);
      await this.store.setItem(KEY, JSON.stringify(list.slice(-MAX_DIAG)));
    });
    this.chain = next.catch(() => undefined); // logging must never break the app
    return next.catch(() => undefined);
  }

  /** Newest first. */
  async read(): Promise<DiagEntry[]> {
    await this.chain;
    return (await this.readNow()).reverse();
  }

  private async readNow(): Promise<DiagEntry[]> {
    try {
      const raw = await this.store.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as DiagEntry[]) : [];
    } catch {
      return [];
    }
  }
}
