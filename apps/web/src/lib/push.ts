import { api } from "./api";

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

export type PushSupport = "supported" | "needs-install" | "unsupported";

/** What the settings card shows. */
export type PushState =
  | "unsupported" // this browser cannot receive Web Push
  | "needs-install" // iPhone / iPad: add the app to the home screen first
  | "server-off" // the server has no VAPID keys
  | "denied" // the user blocked notifications in the browser
  | "off" // not subscribed
  | "on"; // subscribed and known to the server

/** The application server key is sent URL-safe base64; `pushManager.subscribe` wants bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export interface Env {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  userAgent: string;
  standalone: boolean;
}

export function pushSupport(env: Env): PushSupport {
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return "supported";
  // iOS / iPadOS exposes Web Push only to a web app added to the home screen.
  const ios = /iPad|iPhone|iPod/u.test(env.userAgent);
  return ios && !env.standalone ? "needs-install" : "unsupported";
}

export function describePushState(input: {
  support: PushSupport;
  server: PushConfig | null;
  permission: NotificationPermission;
  subscribed: boolean;
}): PushState {
  if (input.support !== "supported")
    return input.support === "needs-install" ? "needs-install" : "unsupported";
  if (input.server && !input.server.enabled) return "server-off";
  if (input.permission === "denied") return "denied";
  return input.subscribed && input.permission === "granted" ? "on" : "off";
}

/** The body `POST /v1/push/subscriptions` expects, or null when the browser gave an incomplete subscription. */
export function toServerBody(
  sub: PushSubscriptionJSON,
): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const { endpoint, keys } = sub;
  if (!endpoint || !keys?.p256dh || !keys.auth) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function browserEnv(): Env {
  return {
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    userAgent: navigator.userAgent,
    standalone:
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true,
  };
}

export const fetchPushConfig = () => api<PushConfig>("/v1/push/config");

/**
 * `pushManager.subscribe` can hang for a long time when the browser's push service is unreachable (firewall, offline);
 * give up after a while so the page does not stay "busy" forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException("Push service did not answer.", "AbortError")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Registers the service worker (idempotent) and waits until it is active. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await registerServiceWorker();
  return registration.pushManager.getSubscription();
}

async function sendToServer(sub: PushSubscription): Promise<void> {
  const body = toServerBody(sub.toJSON());
  if (!body) throw new Error("The browser returned an incomplete push subscription.");
  await api("/v1/push/subscriptions", { method: "POST", body });
}

/**
 * Turns push on for this browser. Must run from a click: the permission prompt needs a user gesture (Safari insists).
 * A subscription made for another server key is replaced, because the push service would reject our messages otherwise.
 */
export async function enablePush(config: PushConfig): Promise<"subscribed" | "denied"> {
  if (!config.enabled || !config.publicKey)
    throw new Error("Push is not configured on the server.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const registration = await registerServiceWorker();
  const key = urlBase64ToUint8Array(config.publicKey);
  let sub = await registration.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await withTimeout(
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key as BufferSource,
    }),
    20_000,
  );
  await sendToServer(sub);
  return "subscribed";
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await api("/v1/push/subscriptions", { method: "DELETE", body: { endpoint } });
}

/**
 * Re-sends the existing subscription to the server. The server upserts, so this is safe on every visit; it repairs the case
 * where the browser replaced its subscription or another admin used this browser in between.
 */
export async function syncSubscription(config: PushConfig): Promise<boolean> {
  if (!config.enabled || Notification.permission !== "granted") return false;
  const sub = await currentSubscription();
  if (!sub) return false;
  const key = config.publicKey ? urlBase64ToUint8Array(config.publicKey) : null;
  if (key && !sameBytes(sub.options.applicationServerKey, key)) return false; // needs a fresh subscribe (a click)
  await sendToServer(sub);
  return true;
}
