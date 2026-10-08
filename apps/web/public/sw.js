/* Timekeeper Work - service worker for Web Push (Org Admin notifications).
 *
 * It only shows push messages and handles clicks. It has no fetch handler and caches nothing, so it can never serve a stale
 * or another user's page. Messages carry no personal data (the server keeps them generic); details are read in the app.
 */

const DEFAULT_TITLE = "Timekeeper Work";
const DEFAULT_BODY = "Шинэ мэдэгдэл байна.";

/** Only same-origin app paths may be opened from a notification ("/device-alerts"), never other sites. */
function safeLink(link) {
  if (typeof link !== "string") return "/notifications";
  if (!link.startsWith("/") || link.startsWith("//") || link.includes("\\"))
    return "/notifications";
  return link;
}

function parsePayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === "object") return data;
  } catch {
    // fall through: a message we cannot read is still worth a generic notification
  }
  return {};
}

function text(value, fallback, max) {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : fallback;
}

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const data = parsePayload(event);
  const title = text(data.title, DEFAULT_TITLE, 120);
  const options = {
    body: text(data.body, DEFAULT_BODY, 300),
    // One notification per kind: a newer one of the same kind replaces the older instead of piling up.
    tag: text(data.tag, "timekeeper", 60),
    renotify: true,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: {
      url: safeLink(data.url),
      notificationId: typeof data.notificationId === "string" ? data.notificationId : null,
    },
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Open admin pages refresh their inbox and unread count.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: "PUSH_RECEIVED" });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    safeLink(event.notification.data && event.notification.data.url),
    self.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open tab of the app instead of opening yet another one.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          if ("navigate" in client) await client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

// The browser replaced or expired the subscription: tell open pages to register the new one with the server.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: "PUSH_SUBSCRIPTION_CHANGED" });
    })(),
  );
});
