/** The storage the outbox needs: AsyncStorage on the phone, a map in tests. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** An event captured by the phone and not yet acknowledged by the server. */
export interface OutboxEvent {
  clientEventId: string;
  type: "ENTER" | "EXIT";
  locationId: string;
  /** When the phone saw it (epoch ms). The age sent to the server is worked out when it is uploaded. */
  capturedAt: number;
  accuracyM?: number;
  mockLocation?: boolean;
  lat?: number;
  lng?: number;
}

const KEY = "outbox.v1";
/** A phone offline for weeks must not fill its storage: the oldest events beyond this are dropped (the server drops events older than 24 h anyway). */
export const MAX_OUTBOX = 500;

/**
 * The queue of events waiting for the server (Architecture 7.4). Every change reads, changes and writes the whole list inside one
 * promise chain, so two geofence callbacks arriving together cannot lose an event. Events keep their order; an event is removed only
 * after the server has answered for it (`acknowledge`).
 */
export class Outbox {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: KeyValueStore) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<OutboxEvent[]> {
    const raw = await this.store.getItem(KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as OutboxEvent[]) : [];
    } catch {
      return []; // a damaged queue must not block new events
    }
  }

  private write(events: OutboxEvent[]): Promise<void> {
    return events.length === 0
      ? this.store.removeItem(KEY)
      : this.store.setItem(KEY, JSON.stringify(events));
  }

  enqueue(event: OutboxEvent): Promise<void> {
    return this.exclusive(async () => {
      const events = await this.read();
      if (events.some((e) => e.clientEventId === event.clientEventId)) return;
      events.push(event);
      await this.write(events.slice(-MAX_OUTBOX));
    });
  }

  /** The oldest `limit` events, oldest first, without removing them. */
  peek(limit: number): Promise<OutboxEvent[]> {
    return this.exclusive(async () => (await this.read()).slice(0, limit));
  }

  acknowledge(clientEventIds: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      const done = new Set(clientEventIds);
      await this.write((await this.read()).filter((e) => !done.has(e.clientEventId)));
    });
  }

  size(): Promise<number> {
    return this.exclusive(async () => (await this.read()).length);
  }
}
