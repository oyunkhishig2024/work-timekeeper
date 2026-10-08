import { describe, expect, it } from "vitest";
import { AbuseDetector, type Escalation, normalize } from "../../src/security/abuse-detector";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const IP = "203.0.113.7";

function make(options = {}) {
  const events: Escalation[] = [];
  const detector = new AbuseDetector(options, (e) => events.push(e));
  return { detector, events };
}

describe("AbuseDetector (behaviour, not only volume)", () => {
  it("ordinary traffic never escalates, and an unknown address is allowed", () => {
    const { detector, events } = make();
    let now = T0;
    for (let i = 0; i < 500; i++) {
      now += 1000;
      expect(detector.check(IP, false, now).action).toBe("allow");
      detector.noteRequest(IP, false, now);
    }
    expect(events).toHaveLength(0);
    expect(detector.inspect(IP, now)?.level).toBe("NORMAL");
  });

  it("a forgetful user (one username, a few failures) is not throttled; credential stuffing (many usernames) is", () => {
    const forgetful = make();
    for (let i = 0; i < 4; i++)
      forgetful.detector.record(IP, { type: "LOGIN_FAILURE", username: "bat" }, T0 + i * 1000);
    expect(forgetful.detector.inspect(IP, T0 + 5000)?.level).toBe("NORMAL");

    const stuffing = make();
    for (let i = 0; i < 4; i++)
      stuffing.detector.record(IP, { type: "LOGIN_FAILURE", username: `user${i}` }, T0 + i * 1000);
    expect(stuffing.detector.inspect(IP, T0 + 5000)?.level).toBe("NORMAL"); // 4 x 8 = 32 points: still below the throttle
    stuffing.detector.record(IP, { type: "LOGIN_FAILURE", username: "user4" }, T0 + 5000); // 5th distinct name
    expect(stuffing.events.map((e) => e.type)).toContain("THROTTLE");
    // the same number of failures for ONE username is far less suspicious
    const sameUser = make();
    for (let i = 0; i < 5; i++)
      sameUser.detector.record(IP, { type: "LOGIN_FAILURE", username: "bat" }, T0 + i * 1000);
    expect(sameUser.detector.inspect(IP, T0 + 6000)?.score).toBeLessThan(
      stuffing.detector.inspect(IP, T0 + 6000)!.score,
    );
  });

  it("probing well-known attack paths escalates quickly: throttle, then a ban on the second probe", () => {
    const { detector, events } = make();
    detector.record(IP, { type: "HONEYPOT" }, T0);
    expect(detector.inspect(IP, T0)?.level).toBe("THROTTLE");
    detector.record(IP, { type: "HONEYPOT" }, T0 + 1000);
    expect(events.map((e) => e.type)).toEqual(["THROTTLE", "BAN"]);
    expect(events[1]).toMatchObject({ strike: 1, reason: "HONEYPOT" });
    expect(events[1]!.until).toBe(T0 + 1000 + 15 * MIN);
  });

  it("many distinct unknown URLs are enumeration; the same missing URL repeated is not", () => {
    const repeated = make();
    for (let i = 0; i < 200; i++)
      repeated.detector.record(IP, { type: "NOT_FOUND", path: "/old-link" }, T0 + i * 100);
    expect(repeated.detector.inspect(IP, T0 + 20_000)?.level).toBe("NORMAL");

    const scan = make();
    for (let i = 0; i < 30; i++)
      scan.detector.record(IP, { type: "NOT_FOUND", path: `/probe-${i}` }, T0 + i * 100);
    expect(scan.events.some((e) => e.type === "BAN" || e.type === "THROTTLE")).toBe(true);
    expect(["THROTTLE", "BLOCK"]).toContain(scan.detector.inspect(IP, T0 + 4000)?.level);
  });

  it("scanner user agents count once an hour", () => {
    const { detector } = make();
    detector.record(IP, { type: "SCANNER_USER_AGENT" }, T0);
    const first = detector.inspect(IP, T0)!.score;
    detector.record(IP, { type: "SCANNER_USER_AGENT" }, T0 + 1000);
    expect(detector.inspect(IP, T0 + 1000)!.score).toBeLessThanOrEqual(first);
    expect(first).toBeGreaterThan(20);
  });

  it("an anonymous flood is throttled, and a sustained one is banned, even if every request is a valid 200", () => {
    const { detector, events } = make({ anonBurstPer10s: 50 });
    let now = T0;
    for (let bucket = 0; bucket < 8; bucket++) {
      for (let i = 0; i < 80; i++) detector.noteRequest(IP, false, now + i * 100);
      now += 10_000;
    }
    expect(events.map((e) => e.type)).toEqual(["THROTTLE", "BAN"]);
    // a short burst alone is not a ban
    const brief = make({ anonBurstPer10s: 50 });
    for (let i = 0; i < 80; i++) brief.detector.noteRequest(IP, false, T0 + i * 100);
    expect(brief.events.some((e) => e.type === "BAN")).toBe(false);
  });

  it("a throttled address may make only a few anonymous requests; ignoring the limit leads to a ban", () => {
    const { detector, events } = make({ throttlePerMinute: 5 });
    detector.record(IP, { type: "HONEYPOT" }, T0); // throttle level
    let allowed = 0;
    let refused = 0;
    let now = T0 + 1000;
    for (let i = 0; i < 100 && !events.some((e) => e.type === "BAN"); i++) {
      const d = detector.check(IP, false, now);
      if (d.action === "allow") allowed++;
      else {
        refused++;
        expect(d.retryAfterSeconds).toBeGreaterThan(0);
        detector.record(IP, { type: "THROTTLED_HIT" }, now); // what the middleware does for a refused request
      }
      now += 500;
    }
    expect(allowed).toBe(5);
    expect(refused).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "BAN")).toBe(true);
  });

  it("a ban blocks anonymous requests with Retry-After, lets signed-in people through, and expires", () => {
    const { detector } = make();
    detector.record(IP, { type: "HONEYPOT" }, T0);
    detector.record(IP, { type: "HONEYPOT" }, T0 + 1000);
    const blocked = detector.check(IP, false, T0 + 2000);
    expect(blocked).toMatchObject({ action: "block", level: "BLOCK" });
    expect(blocked.retryAfterSeconds).toBe(Math.ceil((15 * MIN - 1000) / 1000));
    expect(detector.check(IP, true, T0 + 2000).action).toBe("allow"); // a valid token (e.g. an employee behind the same NAT)
    expect(detector.check(IP, false, T0 + 1000 + 15 * MIN + 1).action).not.toBe("block");
  });

  it("repeat offenders get longer bans (15 min, 1 h, 6 h, 24 h) and strikes are forgotten after a clean week", () => {
    const { detector, events } = make();
    let now = T0;
    const banNow = () => {
      detector.record(IP, { type: "HONEYPOT" }, now);
      detector.record(IP, { type: "HONEYPOT" }, now + 1);
      detector.record(IP, { type: "HONEYPOT" }, now + 2);
      return events.filter((e) => e.type === "BAN").at(-1)!;
    };
    const durations: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ban = banNow();
      durations.push((ban.until - (now + 1)) / MIN);
      now = ban.until + 1; // right after it ends
    }
    expect(durations).toEqual([15, 60, 360, 1440, 1440]);
    expect(events.filter((e) => e.type === "BAN").map((e) => e.strike)).toEqual([1, 2, 3, 4, 5]);
    // a quiet week later it is the first offence again
    now += 8 * 24 * 60 * MIN;
    const again = banNow();
    expect(again.strike).toBe(1);
  });

  it("the score decays: an address that stops misbehaving is released", () => {
    const { detector } = make();
    detector.record(IP, { type: "HONEYPOT" }, T0);
    expect(detector.inspect(IP, T0)?.level).toBe("THROTTLE");
    expect(detector.inspect(IP, T0 + 10 * MIN)?.level).toBe("NORMAL"); // 60 -> 30 after one half-life
    expect(detector.inspect(IP, T0 + 60 * MIN)?.score).toBeLessThan(1);
  });

  it("successful authenticated traffic from the same address lowers its score (shared mobile-network addresses stay healthy)", () => {
    const { detector } = make();
    for (let i = 0; i < 3; i++) detector.record(IP, { type: "UNAUTHORIZED" }, T0 + i);
    const before = detector.inspect(IP, T0 + 10)!.score;
    for (let i = 0; i < 5; i++) detector.recordAuthenticatedOk(IP, T0 + 10);
    expect(detector.inspect(IP, T0 + 10)!.score).toBeLessThan(before);
    // signed-in errors are not recorded at all (the middleware only feeds anonymous failures); the score never goes negative
    for (let i = 0; i < 50; i++) detector.recordAuthenticatedOk(IP, T0 + 10);
    expect(detector.inspect(IP, T0 + 10)!.score).toBe(0);
  });

  it("authenticated bursts are only slowed, never counted as abuse", () => {
    const { detector, events } = make({ authBurstPer10s: 20 });
    detector.record(IP, { type: "UNAUTHORIZED" }, T0);
    let throttled = 0;
    for (let i = 0; i < 60; i++)
      if (detector.check(IP, true, T0 + 100 + i * 10).action === "throttle") throttled++;
    expect(throttled).toBe(40);
    expect(events).toHaveLength(0);
  });

  it("never judges allowlisted addresses (office, monitoring) or loopback", () => {
    const { detector, events } = make({ allowlist: ["198.51.100.0/24", "2001:db8::1"] });
    for (const ip of ["198.51.100.20", "2001:db8::1", "127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      for (let i = 0; i < 10; i++) detector.record(ip, { type: "HONEYPOT" }, T0 + i);
      expect(detector.check(ip, false, T0 + 100).action).toBe("allow");
    }
    expect(events).toHaveLength(0);
    // but the next address is judged
    detector.record("198.51.101.1", { type: "HONEYPOT" }, T0);
    expect(detector.inspect("198.51.101.1", T0)?.level).toBe("THROTTLE");
    expect(() => new AbuseDetector({ allowlist: ["not-an-ip"] })).toThrow(/ABUSE_ALLOWLIST/u);
    // loopback can be turned off for testing the protection itself
    const strict = make({ allowLoopback: false });
    strict.detector.record("127.0.0.1", { type: "HONEYPOT" }, T0);
    expect(strict.detector.inspect("127.0.0.1", T0)?.level).toBe("THROTTLE");
  });

  it("treats IPv4-mapped IPv6 and plain IPv4 as the same client", () => {
    expect(normalize("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(normalize("2001:DB8::1")).toBe("2001:db8::1");
    const { detector } = make();
    detector.record("::ffff:203.0.113.7", { type: "HONEYPOT" }, T0);
    expect(detector.inspect("203.0.113.7", T0)?.level).toBe("THROTTLE");
  });

  it("loads and lifts blocks decided elsewhere (restart, operator) and remembers strikes", () => {
    const { detector, events } = make();
    detector.loadBlock(IP, T0 + 30 * MIN, [T0 - 5 * MIN]);
    expect(detector.check(IP, false, T0).action).toBe("block");
    detector.liftBlock(IP);
    expect(detector.check(IP, false, T0).action).toBe("allow");
    // the earlier strike still counts: the next ban is the 2nd (1 hour)
    detector.record(IP, { type: "HONEYPOT" }, T0 + MIN);
    detector.record(IP, { type: "HONEYPOT" }, T0 + MIN + 1);
    expect(events.find((e) => e.type === "BAN")).toMatchObject({ strike: 2 });
  });

  it("keeps memory bounded and forgets idle harmless addresses", () => {
    const { detector } = make({ maxTrackedIps: 100 });
    for (let i = 0; i < 1000; i++)
      detector.record(`10.${i % 250}.${Math.floor(i / 250)}.9`, { type: "UNAUTHORIZED" }, T0 + i);
    expect(detector.tracked).toBeLessThanOrEqual(100);
    detector.prune(T0 + 60 * MIN);
    expect(detector.tracked).toBe(0);
    // a banned address is never evicted while the ban lasts
    detector.record(IP, { type: "HONEYPOT" }, T0);
    detector.record(IP, { type: "HONEYPOT" }, T0 + 1);
    for (let i = 0; i < 300; i++)
      detector.record(
        `172.16.${i % 200}.${Math.floor(i / 200) + 1}`,
        { type: "UNAUTHORIZED" },
        T0 + 10 + i,
      );
    expect(detector.check(IP, false, T0 + 1000).action).toBe("block");
  });
});
