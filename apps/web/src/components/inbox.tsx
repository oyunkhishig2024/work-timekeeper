"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";

interface Item {
  id: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

interface InboxResponse {
  total: number;
  unread: number;
  items: Item[];
}

const formatter = new Intl.DateTimeFormat("mn-MN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ulaanbaatar",
});

/** The Org Admin's own notifications. Refreshes when the service worker reports a push and once a minute. */
export function Inbox() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<InboxResponse>("/v1/notifications?limit=50"));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Мэдэгдлийг уншиж чадсангүй.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "PUSH_RECEIVED") void load();
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      clearInterval(timer);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [load]);

  async function markRead(id: string | null) {
    await api(id ? `/v1/notifications/${id}/read` : "/v1/notifications/read-all", {
      method: "POST",
    });
    await load();
  }

  return (
    <section aria-labelledby="inbox-title" className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id="inbox-title" className="text-lg font-semibold">
          Мэдэгдэл{data && data.unread > 0 ? ` (${data.unread} уншаагүй)` : ""}
        </h2>
        {data && data.unread > 0 && (
          <button
            type="button"
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-100"
            onClick={() => void markRead(null)}
          >
            Бүгдийг уншсан болгох
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {data && data.items.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">Мэдэгдэл байхгүй байна.</p>
      )}
      <ul className="mt-3 space-y-2">
        {data?.items.map((n) => (
          <li
            key={n.id}
            className={`rounded-lg border p-3 ${n.readAt ? "border-slate-200 bg-white" : "border-teal-300 bg-teal-50"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{n.title}</p>
                <p className="mt-0.5 text-sm text-slate-700">{n.body}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {formatter.format(new Date(n.createdAt))}
                </p>
              </div>
              {!n.readAt && (
                <button
                  type="button"
                  className="min-h-11 shrink-0 rounded-md border border-slate-300 bg-white px-3 text-sm hover:bg-slate-100"
                  onClick={() => void markRead(n.id)}
                >
                  Уншсан
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
