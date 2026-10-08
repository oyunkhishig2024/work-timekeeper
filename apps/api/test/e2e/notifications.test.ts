import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttestationVerifier } from "../../src/devices/attestation";
import { NotificationsService } from "../../src/notifications/notifications.service";
import {
  isAllowedPushEndpoint,
  PushDeliveryError,
  PushSender,
  pushRetryDelayMinutes,
  type PushPayload,
  type PushTarget,
} from "../../src/notifications/push-sender";
import { hasDb } from "../db/helpers";
import { at, attendanceKit, WORK_DATE, type W } from "./attendance-kit";
import { createEmployee, createUser, type Harness, signIn, startHarness } from "./harness";

const FCM = "https://fcm.googleapis.com/fcm/send/abc123";
const MOZ = "https://updates.push.services.mozilla.com/wpush/v2/xyz";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

describe("push helpers", () => {
  const hosts =
    "fcm.googleapis.com,updates.push.services.mozilla.com,*.push.apple.com,*.notify.windows.com";
  it("accepts only https endpoints of the known push services", () => {
    expect(isAllowedPushEndpoint(FCM, hosts)).toBe(true);
    expect(isAllowedPushEndpoint(MOZ, hosts)).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QAbc", hosts)).toBe(true);
    expect(isAllowedPushEndpoint("https://db5p.notify.windows.com/?token=x", hosts)).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://localhost/x",
      "https://169.254.169.254/latest/meta-data",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com/x",
      "https://push.apple.com/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "not a url",
    ]) {
      expect(isAllowedPushEndpoint(bad, hosts), bad).toBe(false);
    }
  });
  it("retries after 1, 5, 30 and 120 minutes, then gives up", () => {
    expect([1, 2, 3, 4, 5].map(pushRetryDelayMinutes)).toEqual([1, 5, 30, 120, null]);
  });
});

describe.skipIf(!hasDb)("Org Admin notifications and Web Push (PRD 6.7, 6.9)", () => {
  let h: Harness;
  let k: ReturnType<typeof attendanceKit>;
  beforeAll(async () => {
    h = await startHarness();
    k = attendanceKit(h);
  });
  afterAll(async () => {
    await h.close();
  });

  /** Replaces the Web Push sender for the duration of `fn`; `behave` decides what each send does. */
  async function withPush<T>(
    behave: (target: PushTarget, payload: PushPayload) => void | Promise<void>,
    fn: (sent: Array<{ target: PushTarget; payload: PushPayload }>) => Promise<T>,
  ): Promise<T> {
    const sender = h.app.get(PushSender) as unknown as {
      enabled: boolean;
      send: PushSender["send"];
    };
    const original = { enabled: sender.enabled, send: sender.send };
    const sent: Array<{ target: PushTarget; payload: PushPayload }> = [];
    sender.enabled = true;
    sender.send = async (target, payload) => {
      await behave(target, payload);
      sent.push({ target, payload });
    };
    try {
      return await fn(sent);
    } finally {
      sender.enabled = original.enabled;
      sender.send = original.send;
    }
  }
  const service = () => h.app.get(NotificationsService);
  const rows = async (tenantId: string, kind?: string) =>
    (
      await h.owner.query(
        `SELECT n.*, u.role, u.username FROM notification n JOIN user_account u ON u.id = n.user_id
          WHERE n.tenant_id = $1 ${kind ? "AND n.kind = $2" : ""} ORDER BY n.created_at`,
        kind ? [tenantId, kind] : [tenantId],
      )
    ).rows;
  async function triggerStreak(w: W) {
    const verifier = h.app.get(AttestationVerifier);
    const original = verifier.verifyBatch.bind(verifier);
    verifier.verifyBatch = async () => {
      throw new Error("Google is down");
    };
    try {
      k.setClock("08:00");
      for (let i = 0; i < 5; i++) {
        await k.post(await k.emp(w), "/v1/events", { events: [k.ev(w)] });
      }
    } finally {
      verifier.verifyBatch = original;
    }
  }

  describe("what is announced, and to whom", () => {
    it("a device alert goes to every active Org Admin (not HR), with a generic text, once", async () => {
      const w = await k.world();
      const admin2 = await createUser(h, w.tenant, { username: "admin2", role: "ORG_ADMIN" });
      const disabled = await createUser(h, w.tenant, { username: "admin3", role: "ORG_ADMIN" });
      await h.owner.query("UPDATE user_account SET status = 'DISABLED' WHERE id = $1", [
        disabled.id,
      ]);
      await triggerStreak(w);

      const list = await rows(w.tenant.id, "DEVICE_ALERT_ATTESTATION");
      expect(list.map((r) => r.username).sort()).toEqual(["admin", "admin2"]);
      expect(list.every((r) => r.role === "ORG_ADMIN" && r.push_state === "PENDING")).toBe(true);
      expect(list[0]).toMatchObject({
        title: "Төхөөрөмжийн баталгаажуулалт тасарлаа",
        link: "/device-alerts",
      });
      // No name, code or place travels through the push service.
      const text = JSON.stringify(list.map((r) => [r.title, r.body, r.link]));
      expect(text).not.toContain(w.employee.id);
      expect(text).not.toMatch(/Бадам|Төв салбар/u);
      expect(admin2.id).toBeTruthy();
      // The sixth unavailable batch does not open another alert, so nobody is told again.
      const before = (await rows(w.tenant.id)).length;
      const verifier = h.app.get(AttestationVerifier);
      const original = verifier.verifyBatch.bind(verifier);
      verifier.verifyBatch = async () => {
        throw new Error("down");
      };
      try {
        await k.post(await k.emp(w), "/v1/events", { events: [k.ev(w)] });
      } finally {
        verifier.verifyBatch = original;
      }
      expect((await rows(w.tenant.id)).length).toBe(before);
    });

    it("a DEVICE_CONFLICT alert is announced with its own text", async () => {
      const w = await k.world();
      k.setClock("07:05");
      await k.post(await k.emp(w), "/v1/events", {
        events: [k.ev(w)],
        attestationKeyId: "another-install",
      });
      const list = await rows(w.tenant.id, "DEVICE_ALERT_CONFLICT");
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        title: "Төхөөрөмжийн зөрчил илэрлээ",
        link: "/device-alerts",
      });
    });

    it("more than 10 corrections by one user in a day tell the Org Admin once; ten do not", async () => {
      const w = await k.world();
      k.setClock("18:00");
      const extra = [];
      for (let i = 0; i < 10; i++) extra.push(await createEmployee(h, w.tenant));
      await k.tick(w.tenant.id);
      const hr = await signIn(h, w.hr).then((t) => t.accessToken);
      const correct = (employeeId: string) =>
        k.post(hr, "/v1/attendance/corrections", {
          employeeId,
          workDate: WORK_DATE,
          status: "ON_TIME",
          arrivalAt: at("08:05").toISOString(),
          reasonCode: "APP_ISSUE",
        });
      for (const e of extra) expect((await correct(e.id)).status).toBe(201);
      expect(await rows(w.tenant.id, "CORRECTION_VOLUME")).toHaveLength(0);
      expect((await correct(w.employee.id)).status).toBe(201); // the 11th
      const list = await rows(w.tenant.id, "CORRECTION_VOLUME");
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ username: "admin", link: "/corrections/report" });
      // A 12th (a replacement) does not announce it again.
      expect((await correct(w.employee.id)).status).toBe(201);
      expect(await rows(w.tenant.id, "CORRECTION_VOLUME")).toHaveLength(1);
    });
  });

  describe("inbox and subscription API", () => {
    it("the inbox is private to the admin, counts unread, and can be marked read", async () => {
      const w = await k.world();
      const other = await createUser(h, w.tenant, {
        username: "admin2",
        role: "ORG_ADMIN",
        totp: true,
      });
      await triggerStreak(w);
      const admin = (await signIn(h, w.admin)).accessToken;
      const inbox = await k.get(admin, "/v1/notifications");
      expect(inbox.status).toBe(200);
      expect(inbox.body).toMatchObject({ total: 1, unread: 1 });
      expect(inbox.body.items[0]).toMatchObject({ kind: "DEVICE_ALERT_ATTESTATION", readAt: null });

      // The other admin cannot read or mark this one.
      const otherToken = (await signIn(h, other)).accessToken;
      const mine = inbox.body.items[0].id as string;
      expect((await k.post(otherToken, `/v1/notifications/${mine}/read`)).status).toBe(404);
      expect((await k.get(otherToken, "/v1/notifications")).body.items[0].id).not.toBe(mine);

      expect((await k.post(admin, `/v1/notifications/${mine}/read`)).body).toEqual({ marked: 1 });
      const after = await k.get(admin, "/v1/notifications?unread=true");
      expect(after.body).toMatchObject({ total: 0, unread: 0 });
      expect((await k.get(admin, "/v1/notifications")).body.items[0].readAt).not.toBeNull();
      expect((await k.post(admin, "/v1/notifications/read-all")).body).toEqual({ marked: 0 });
    });

    it("only Org Admin uses it: HR, Manager and Employee are refused", async () => {
      const w = await k.world();
      const hr = (await signIn(h, w.hr)).accessToken;
      expect((await k.get(hr, "/v1/notifications")).status).toBe(403);
      expect((await k.get(hr, "/v1/push/config")).status).toBe(403);
      expect((await k.get(await k.emp(w), "/v1/notifications")).status).toBe(403);
    });

    it("subscribes a browser, refuses unknown endpoints, takes over, and unsubscribes", async () => {
      const w = await k.world();
      const admin = (await signIn(h, w.admin)).accessToken;
      const cfg = await k.get(admin, "/v1/push/config");
      expect(cfg.body).toEqual({ enabled: false, publicKey: null });

      const bad = await k.post(admin, "/v1/push/subscriptions", {
        endpoint: "https://169.254.169.254/x",
        keys: KEYS,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("PUSH_ENDPOINT_NOT_ALLOWED");
      expect(
        (await k.post(admin, "/v1/push/subscriptions", { endpoint: FCM, keys: { p256dh: "" } }))
          .status,
      ).toBe(400);

      expect(
        (await k.post(admin, "/v1/push/subscriptions", { endpoint: FCM, keys: KEYS })).status,
      ).toBe(201);
      expect(
        (await k.post(admin, "/v1/push/subscriptions", { endpoint: FCM, keys: KEYS })).status,
      ).toBe(201);
      const stored = await h.owner.query(
        "SELECT user_id, disabled_at FROM push_subscription WHERE endpoint = $1",
        [FCM],
      );
      expect(stored.rows).toHaveLength(1);

      const del = await h
        .http()
        .delete("/v1/push/subscriptions")
        .set({ Authorization: `Bearer ${admin}` })
        .send({ endpoint: FCM });
      expect(del.status).toBe(200);
      expect(
        (
          await h.owner.query("SELECT disabled_at FROM push_subscription WHERE endpoint = $1", [
            FCM,
          ])
        ).rows[0].disabled_at,
      ).not.toBeNull();
      // Subscribing again switches it back on.
      await k.post(admin, "/v1/push/subscriptions", { endpoint: FCM, keys: KEYS });
      expect(
        (
          await h.owner.query("SELECT disabled_at FROM push_subscription WHERE endpoint = $1", [
            FCM,
          ])
        ).rows[0].disabled_at,
      ).toBeNull();
    });
  });

  describe("delivery by the worker", () => {
    const subscribe = async (w: W, endpoint = FCM) => {
      const admin = (await signIn(h, w.admin)).accessToken;
      await k.post(admin, "/v1/push/subscriptions", { endpoint, keys: KEYS });
      return admin;
    };

    it("pushes a due notification to the admin's subscription and marks it sent", async () => {
      const w = await k.world();
      await subscribe(w);
      await triggerStreak(w);
      await withPush(
        () => undefined,
        async (sent) => {
          expect(await service().dispatchTenant(w.tenant.id)).toBe(1);
          expect(sent).toHaveLength(1);
          expect(sent[0]!.target.endpoint).toBe(FCM);
          expect(sent[0]!.payload).toMatchObject({
            title: "Төхөөрөмжийн баталгаажуулалт тасарлаа",
            url: "/device-alerts",
            tag: "DEVICE_ALERT_ATTESTATION",
          });
          // Nothing is sent twice.
          expect(await service().dispatchTenant(w.tenant.id)).toBe(0);
          expect(sent).toHaveLength(1);
        },
      );
      const [row] = await rows(w.tenant.id, "DEVICE_ALERT_ATTESTATION");
      expect(row).toMatchObject({ push_state: "SENT", push_attempts: 0 });
      expect(row.push_sent_at).not.toBeNull();
      const admin = (await signIn(h, w.admin)).accessToken;
      expect((await k.get(admin, "/v1/notifications")).body.items[0].pushState).toBe("SENT");
    });

    it("without VAPID keys or without a subscribed browser the inbox is the delivery (SKIPPED)", async () => {
      const w = await k.world();
      await triggerStreak(w);
      expect(await service().dispatchTenant(w.tenant.id)).toBe(0); // push disabled in tests
      expect((await rows(w.tenant.id))[0]!.push_state).toBe("SKIPPED");

      const w2 = await k.world();
      await triggerStreak(w2);
      await withPush(
        () => undefined,
        async (sent) => {
          await service().dispatchTenant(w2.tenant.id);
          expect(sent).toHaveLength(0);
        },
      );
      expect((await rows(w2.tenant.id))[0]!.push_state).toBe("SKIPPED");
    });

    it("a gone subscription (410) is switched off and the others still get the message", async () => {
      const w = await k.world();
      await subscribe(w, FCM);
      await subscribe(w, MOZ);
      await triggerStreak(w);
      await withPush(
        (target) => {
          if (target.endpoint === FCM) throw new PushDeliveryError(410, "Gone");
        },
        async (sent) => {
          expect(await service().dispatchTenant(w.tenant.id)).toBe(1);
          expect(sent.map((s) => s.target.endpoint)).toEqual([MOZ]);
        },
      );
      const subs = await h.owner.query(
        "SELECT endpoint, disabled_at FROM push_subscription WHERE tenant_id = $1 ORDER BY endpoint",
        [w.tenant.id],
      );
      expect(subs.rows.find((s) => s.endpoint === FCM).disabled_at).not.toBeNull();
      expect(subs.rows.find((s) => s.endpoint === MOZ).disabled_at).toBeNull();
    });

    it("a failing push service is retried after 1, 5, 30 and 120 minutes, then the notification is FAILED", async () => {
      const w = await k.world();
      await subscribe(w);
      await triggerStreak(w);
      const row = async () => (await rows(w.tenant.id, "DEVICE_ALERT_ATTESTATION"))[0]!;
      await withPush(
        () => {
          throw new PushDeliveryError(503, "Service Unavailable");
        },
        async () => {
          const waits = [1, 5, 30, 120];
          for (const [i, minutes] of waits.entries()) {
            await service().dispatchTenant(w.tenant.id);
            const r = await row();
            expect(r).toMatchObject({ push_state: "PENDING", push_attempts: i + 1 });
            expect(r.push_error).toContain("503");
            const due = (r.next_attempt_at as Date).getTime() - h.clock.now().getTime();
            expect(due).toBe(minutes * 60_000);
            // Not due yet: nothing happens.
            await service().dispatchTenant(w.tenant.id);
            expect((await row()).push_attempts).toBe(i + 1);
            h.clock.advanceSeconds(minutes * 60);
          }
          await service().dispatchTenant(w.tenant.id);
          expect(await row()).toMatchObject({ push_state: "FAILED", push_attempts: 5 });
        },
      );
      // The inbox still has it.
      const admin = (await signIn(h, w.admin)).accessToken;
      expect((await k.get(admin, "/v1/notifications")).body.total).toBe(1);
    });

    it("a successful retry ends as SENT", async () => {
      const w = await k.world();
      await subscribe(w);
      await triggerStreak(w);
      let fail = true;
      await withPush(
        () => {
          if (fail) throw new PushDeliveryError(500, "boom");
        },
        async (sent) => {
          await service().dispatchTenant(w.tenant.id);
          fail = false;
          h.clock.advanceSeconds(61);
          expect(await service().dispatchTenant(w.tenant.id)).toBe(1);
          expect(sent).toHaveLength(1);
        },
      );
      expect((await rows(w.tenant.id, "DEVICE_ALERT_ATTESTATION"))[0]).toMatchObject({
        push_state: "SENT",
        push_attempts: 1,
      });
    });

    it("the test button queues a message for the caller only", async () => {
      const w = await k.world();
      await subscribe(w);
      const admin = (await signIn(h, w.admin)).accessToken;
      expect((await k.post(admin, "/v1/push/test")).status).toBe(202);
      expect((await k.post(admin, "/v1/push/test")).status).toBe(202);
      await withPush(
        () => undefined,
        async (sent) => {
          expect(await service().dispatchTenant(w.tenant.id)).toBe(2);
          expect(sent[0]!.payload.title).toBe("Туршилтын мэдэгдэл");
        },
      );
    });

    it("one tenant's notifications never reach another tenant's subscriptions", async () => {
      const a = await k.world();
      const b = await k.world();
      await subscribe(b, MOZ);
      await triggerStreak(a);
      await withPush(
        () => undefined,
        async (sent) => {
          await service().dispatchTenant(a.tenant.id);
          await service().dispatchTenant(b.tenant.id);
          expect(sent).toHaveLength(0);
        },
      );
    });
  });
});
