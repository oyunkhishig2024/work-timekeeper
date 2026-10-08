import { describe, expect, it } from "vitest";
import {
  describePushState,
  pushSupport,
  sameBytes,
  toServerBody,
  urlBase64ToUint8Array,
  type Env,
} from "../src/lib/push";

const env = (over: Partial<Env> = {}): Env => ({
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130",
  standalone: false,
  ...over,
});

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 without padding", () => {
    // 65-byte uncompressed P-256 key shape: 0x04 followed by 64 bytes; use a short known vector instead.
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([0xfb, 0xff]); // "-_" are "+/"
    expect(Array.from(urlBase64ToUint8Array("AQI"))).toEqual([1, 2]); // missing padding is added
  });
});

describe("sameBytes", () => {
  it("compares the key of an existing subscription with the server key", () => {
    const key = Uint8Array.from([1, 2, 3]);
    expect(sameBytes(key.buffer.slice(0) as ArrayBuffer, key)).toBe(true);
    expect(sameBytes(Uint8Array.from([1, 2, 4]).buffer as ArrayBuffer, key)).toBe(false);
    expect(sameBytes(Uint8Array.from([1, 2]).buffer as ArrayBuffer, key)).toBe(false);
    expect(sameBytes(null, key)).toBe(false);
  });
});

describe("pushSupport", () => {
  it("is supported when service workers, push and notifications exist", () => {
    expect(pushSupport(env())).toBe("supported");
  });
  it("an iPhone browser tab must be installed to the home screen first", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1";
    expect(pushSupport(env({ userAgent: iphone, hasPushManager: false }))).toBe("needs-install");
    expect(pushSupport(env({ userAgent: iphone, standalone: true }))).toBe("supported");
  });
  it("other browsers without the APIs are unsupported", () => {
    expect(pushSupport(env({ hasPushManager: false }))).toBe("unsupported");
  });
});

describe("describePushState", () => {
  const server = { enabled: true, publicKey: "k" };
  const base = {
    support: "supported" as const,
    server,
    permission: "default" as const,
    subscribed: false,
  };
  it("walks through the states the card shows", () => {
    expect(describePushState({ ...base, support: "unsupported" })).toBe("unsupported");
    expect(describePushState({ ...base, support: "needs-install" })).toBe("needs-install");
    expect(describePushState({ ...base, server: { enabled: false, publicKey: null } })).toBe(
      "server-off",
    );
    expect(describePushState({ ...base, permission: "denied" })).toBe("denied");
    expect(describePushState(base)).toBe("off");
    expect(describePushState({ ...base, permission: "granted" })).toBe("off");
    expect(describePushState({ ...base, permission: "granted", subscribed: true })).toBe("on");
  });
  it("a subscription without permission (revoked in settings) is off", () => {
    expect(describePushState({ ...base, permission: "default", subscribed: true })).toBe("off");
  });
});

describe("toServerBody", () => {
  it("builds the API body and refuses incomplete subscriptions", () => {
    expect(
      toServerBody({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } }),
    ).toEqual({
      endpoint: "https://fcm.googleapis.com/x",
      keys: { p256dh: "a", auth: "b" },
    });
    expect(toServerBody({ endpoint: "https://x", keys: { p256dh: "a" } })).toBeNull();
    expect(toServerBody({ keys: { p256dh: "a", auth: "b" } })).toBeNull();
  });
});
