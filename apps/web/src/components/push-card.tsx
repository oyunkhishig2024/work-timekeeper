"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import {
  browserEnv,
  currentSubscription,
  describePushState,
  disablePush,
  enablePush,
  fetchPushConfig,
  pushSupport,
  syncSubscription,
  type PushConfig,
  type PushState,
} from "@/lib/push";

const TEXT: Record<PushState, string> = {
  unsupported:
    "Энэ хөтөч push мэдэгдэл дэмждэггүй. Chrome, Edge, Firefox эсвэл Safari-н сүүлийн хувилбарыг ашиглана уу.",
  "needs-install":
    "iPhone/iPad дээр push мэдэгдэл авахын тулд эхлээд «Share» → «Add to Home Screen» хийж апп-аа суулгана уу, дараа нь тэр апп-аас нээнэ үү.",
  "server-off":
    "Сервер дээр push мэдэгдэл тохируулагдаагүй байна (VAPID түлхүүр). Мэдэгдэл доорх жагсаалтад л харагдана.",
  denied:
    "Энэ хөтөч дээр мэдэгдлийг хориглосон байна. Хаягийн мөрний түгжээний тохиргооноос зөвшөөрч, хуудсыг шинэчилнэ үү.",
  off: "Push мэдэгдэл энэ хөтөч дээр унтраастай байна.",
  on: "Push мэдэгдэл энэ хөтөч дээр асаалттай. Төхөөрөмжийн сэрэмжлүүлэг, олон засварын мэдэгдэл шууд ирнэ.",
};

const button =
  "min-h-11 rounded-md px-4 font-semibold disabled:opacity-60 border border-slate-300 bg-white hover:bg-slate-100";

/** `pushManager.subscribe` fails with AbortError when the browser cannot reach its push service (Google, Mozilla, Apple). */
function failureText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Хөтчийн push үйлчилгээнд холбогдож чадсангүй. Интернэт, firewall эсвэл хувийн (incognito) цонх эсэхийг шалгана уу.";
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Мэдэгдлийг хөтөч зөвшөөрсөнгүй.";
  }
  return "Алдаа гарлаа. Дахин оролдоно уу.";
}

/** Settings card: turn Web Push on or off for this browser and send a test message. */
export function PushCard() {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [state, setState] = useState<PushState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (cfg: PushConfig) => {
    const support = pushSupport(browserEnv());
    const subscribed = support === "supported" ? (await currentSubscription()) !== null : false;
    const permission = support === "supported" ? Notification.permission : "default";
    setState(describePushState({ support, server: cfg, permission, subscribed }));
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const cfg = await fetchPushConfig();
      if (!alive) return;
      setConfig(cfg);
      // Repair the server's copy of this browser's subscription (it may have been replaced) before showing the state.
      if (pushSupport(browserEnv()) === "supported") await syncSubscription(cfg).catch(() => false);
      await refresh(cfg);
    })().catch((e) =>
      setMessage(e instanceof ApiRequestError ? e.message : "Тохиргоог уншиж чадсангүй."),
    );
    return () => {
      alive = false;
    };
  }, [refresh]);

  // The service worker asks open pages to re-register a subscription the browser replaced.
  useEffect(() => {
    if (!config) return;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "PUSH_SUBSCRIPTION_CHANGED") {
        void syncSubscription(config).then(() => refresh(config));
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [config, refresh]);

  async function run(action: () => Promise<string | void>) {
    if (!config) return;
    setBusy(true);
    setMessage(null);
    try {
      const note = await action();
      if (note) setMessage(note);
    } catch (e) {
      setMessage(failureText(e));
    } finally {
      await refresh(config).catch(() => undefined);
      setBusy(false);
    }
  }

  const canToggle = state === "off" || state === "on" || state === "denied";
  return (
    <section
      aria-labelledby="push-title"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 id="push-title" className="text-lg font-semibold">
        Push мэдэгдэл
      </h2>
      <p className="mt-1 text-sm text-slate-700">{state ? TEXT[state] : "Шалгаж байна…"}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(state === "off" || state === "denied") && (
          <button
            type="button"
            disabled={busy || !canToggle}
            className={`${button} border-teal-700 bg-teal-700 text-white hover:bg-teal-800`}
            onClick={() =>
              void run(async () => {
                const result = await enablePush(config!);
                if (result === "denied") return "Зөвшөөрөл өгөөгүй тул асаасангүй.";
              })
            }
          >
            Асаах
          </button>
        )}
        {state === "on" && (
          <>
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() => void run(disablePush)}
            >
              Унтраах
            </button>
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() =>
                void run(async () => {
                  await api("/v1/push/test", { method: "POST" });
                  return "Туршилтын мэдэгдэл илгээлээ. Хэдэн секундын дотор ирнэ.";
                })
              }
            >
              Туршилтын мэдэгдэл илгээх
            </button>
          </>
        )}
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm text-slate-800">
          {message}
        </p>
      )}
    </section>
  );
}
