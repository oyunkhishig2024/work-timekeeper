import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

/** Runs public/sw.js against a fake service worker scope and returns what it did. */
function load(
  opts: { windows?: Array<{ url: string; focus?: boolean; navigate?: boolean }> } = {},
) {
  const listeners = new Map<string, Listener>();
  const log = {
    shown: [] as Array<{ title: string; options: Record<string, unknown> }>,
    posted: [] as unknown[],
    opened: [] as string[],
    focused: [] as string[],
    navigated: [] as string[],
    claimed: false,
    skipped: false,
  };
  const clients = (opts.windows ?? []).map((w) => ({
    url: w.url,
    focus: () => {
      log.focused.push(w.url);
      return Promise.resolve();
    },
    navigate: (to: string) => {
      log.navigated.push(to);
      return Promise.resolve();
    },
    postMessage: (m: unknown) => log.posted.push(m),
  }));
  const self = {
    location: { origin: "https://admin.example.com" },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: () => {
      log.skipped = true;
      return Promise.resolve();
    },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        log.shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => {
        log.claimed = true;
        return Promise.resolve();
      },
      matchAll: () => Promise.resolve(clients),
      openWindow: (url: string) => {
        log.opened.push(url);
        return Promise.resolve();
      },
    },
  };
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    self,
    URL,
    JSON,
    Promise,
  });
  /** Fires an event and waits for what it passed to waitUntil. */
  const fire = async (type: string, event: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { fire, log };
}

const pushWith = (data: unknown) => ({ data: { json: () => data } });

describe("service worker: push", () => {
  it("shows the notification from the payload and tells open pages", async () => {
    const sw = load({ windows: [{ url: "https://admin.example.com/notifications" }] });
    await sw.fire(
      "push",
      pushWith({
        title: "Төхөөрөмжийн зөрчил илэрлээ",
        body: "Админ самбараас шалгана уу.",
        url: "/device-alerts",
        tag: "DEVICE_ALERT_CONFLICT",
        notificationId: "n-1",
      }),
    );
    expect(sw.log.shown).toHaveLength(1);
    expect(sw.log.shown[0]).toMatchObject({
      title: "Төхөөрөмжийн зөрчил илэрлээ",
      options: {
        body: "Админ самбараас шалгана уу.",
        tag: "DEVICE_ALERT_CONFLICT",
        data: { url: "/device-alerts", notificationId: "n-1" },
      },
    });
    expect(sw.log.posted).toEqual([{ type: "PUSH_RECEIVED" }]);
  });

  it("still shows a generic notification when the payload is empty or unreadable (a push must always be visible)", async () => {
    const empty = load();
    await empty.fire("push", { data: null });
    const broken = load();
    await broken.fire("push", {
      data: {
        json: () => {
          throw new SyntaxError("bad json");
        },
      },
    });
    for (const sw of [empty, broken]) {
      expect(sw.log.shown).toHaveLength(1);
      expect(sw.log.shown[0]!.title).toBe("Timekeeper Work");
      expect((sw.log.shown[0]!.options.data as { url: string }).url).toBe("/notifications");
    }
  });

  it("never carries a link to another site", async () => {
    for (const url of [
      "https://evil.example/x",
      "//evil.example/x",
      "javascript:alert(1)",
      "/\\evil.example",
      42,
      null,
    ]) {
      const sw = load();
      await sw.fire("push", pushWith({ title: "t", body: "b", url }));
      expect((sw.log.shown[0]!.options.data as { url: string }).url, String(url)).toBe(
        "/notifications",
      );
    }
  });

  it("limits the size of the texts and ignores non-string fields", async () => {
    const sw = load();
    await sw.fire("push", pushWith({ title: "x".repeat(500), body: { evil: true }, tag: 7 }));
    expect((sw.log.shown[0]!.title as string).length).toBe(120);
    expect(sw.log.shown[0]!.options.body).toBe("Шинэ мэдэгдэл байна.");
    expect(sw.log.shown[0]!.options.tag).toBe("timekeeper");
  });
});

describe("service worker: click", () => {
  const click = (url: unknown) => ({ notification: { close: () => undefined, data: { url } } });

  it("focuses an open tab of the app and moves it to the notification's page", async () => {
    const sw = load({ windows: [{ url: "https://admin.example.com/notifications" }] });
    await sw.fire("notificationclick", click("/device-alerts"));
    expect(sw.log.navigated).toEqual(["https://admin.example.com/device-alerts"]);
    expect(sw.log.focused).toEqual(["https://admin.example.com/notifications"]);
    expect(sw.log.opened).toEqual([]);
  });

  it("ignores tabs of other sites and opens a new window when there is none", async () => {
    const sw = load({ windows: [{ url: "https://other.example/" }] });
    await sw.fire("notificationclick", click("/device-alerts"));
    expect(sw.log.opened).toEqual(["https://admin.example.com/device-alerts"]);
    expect(sw.log.focused).toEqual([]);
  });

  it("a tampered link falls back to the notifications page", async () => {
    const sw = load();
    await sw.fire("notificationclick", click("https://evil.example/"));
    expect(sw.log.opened).toEqual(["https://admin.example.com/notifications"]);
  });
});

describe("service worker: lifecycle", () => {
  it("activates at once, claims open pages, and caches nothing", async () => {
    const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bcaches\.|addEventListener\("fetch"/u);
    const sw = load();
    await sw.fire("install");
    await sw.fire("activate");
    expect(sw.log.skipped).toBe(true);
    expect(sw.log.claimed).toBe(true);
  });

  it("asks open pages to re-register when the browser replaces the subscription", async () => {
    const sw = load({ windows: [{ url: "https://admin.example.com/notifications" }] });
    await sw.fire("pushsubscriptionchange");
    expect(sw.log.posted).toEqual([{ type: "PUSH_SUBSCRIPTION_CHANGED" }]);
  });
});
