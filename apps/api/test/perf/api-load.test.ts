import { afterAll, beforeAll, describe, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit, WORK_DATE } from "../e2e/attendance-kit";
import {
  createEmployeeWithUser,
  type Harness,
  signConsentSql,
  signIn,
  startHarness,
} from "../e2e/harness";

/**
 * A rough load check, not part of the normal test run: `PERF=1 pnpm --filter @timekeeper/api exec vitest run test/perf`.
 * One organization with EMPLOYEES employees and a daily result each, an HR user, N requests at a fixed concurrency per
 * endpoint, in-process (no network), against the test database. It prints latency percentiles. Numbers depend on the machine:
 * compare runs on the same machine, and repeat on the real server size before relying on them.
 */
const EMPLOYEES = Number(process.env.PERF_EMPLOYEES ?? 2000);
const REQUESTS = Number(process.env.PERF_REQUESTS ?? 200);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 20);

async function pool(total: number, concurrency: number, job: () => Promise<number>) {
  const times: number[] = [];
  let started = 0;
  const begin = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (started < total) {
        started += 1;
        times.push(await job());
      }
    }),
  );
  const seconds = (performance.now() - begin) / 1000;
  times.sort((a, b) => a - b);
  const at = (p: number) =>
    Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]!);
  return { n: total, rps: Math.round(total / seconds), p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

describe.skipIf(!hasDb || !process.env.PERF)("API load check", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("prints latency for the main list and report endpoints", async () => {
    const k = attendanceKit(h);
    const w = await k.world();
    await h.owner.query(
      `INSERT INTO employee (tenant_id, employee_no, full_name, last_name, first_name, department_id, primary_location_id)
       SELECT $1, '9' || lpad(g::text, 15, '0'), 'Овог' || g || ' Нэр' || g, 'Овог' || g, 'Нэр' || g,
              (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1), (SELECT id FROM location WHERE tenant_id = $1 LIMIT 1)
         FROM generate_series(1, $2::int) g`,
      [w.tenant.id, EMPLOYEES],
    );
    await h.owner.query(
      `INSERT INTO attendance_result (tenant_id, employee_id, work_date, status, location_id, expected_start, expected_cutoff, arrival_at, late_minutes, computed_at)
       SELECT e.tenant_id, e.id, $2::date, (ARRAY['ON_TIME','LATE','NO_SHOW'])[1 + (row_number() OVER ())::int % 3], e.primary_location_id,
              ($2::date + time '00:00') AT TIME ZONE 'UTC', ($2::date + time '01:00') AT TIME ZONE 'UTC', NULL, 0, now()
         FROM employee e WHERE e.tenant_id = $1 AND e.employee_no LIKE '9%'
       ON CONFLICT DO NOTHING`,
      [w.tenant.id, WORK_DATE],
    );
    const token = (await signIn(h, w.hr)).accessToken;
    const auth = { Authorization: `Bearer ${token}` };
    const timed = (url: string) => async () => {
      const t = performance.now();
      const res = await h.http().get(url).set(auth);
      if (res.status !== 200)
        throw new Error(`${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      return performance.now() - t;
    };
    const rows: Array<Record<string, unknown>> = [];
    const endpoints: Array<[string, string, number, number]> = [
      ["GET /employees?limit=50", "/v1/employees?limit=50", REQUESTS, CONCURRENCY],
      [
        "GET /employees?q=Нэр1",
        "/v1/employees?q=%D0%9D%D1%8D%D1%801&limit=50",
        REQUESTS,
        CONCURRENCY,
      ],
      [
        "GET /attendance/daily (page of 100)",
        `/v1/attendance/daily?date=${WORK_DATE}&limit=100`,
        REQUESTS,
        CONCURRENCY,
      ],
      [
        "GET /attendance/summary",
        `/v1/attendance/summary?date=${WORK_DATE}`,
        REQUESTS,
        CONCURRENCY,
      ],
      ["GET /employees (health of auth only: /v1/health)", "/v1/health", REQUESTS, CONCURRENCY],
    ];
    await timed("/v1/employees?limit=1")(); // warm up
    for (const [name, url, n, c] of endpoints) {
      const r = await pool(
        n,
        c,
        url === "/v1/health"
          ? async () => {
              const t = performance.now();
              await h.http().get(url);
              return performance.now() - t;
            }
          : timed(url),
      );
      rows.push({
        endpoint: name,
        requests: r.n,
        concurrency: c,
        "req/s": r.rps,
        "p50 ms": r.p50,
        "p95 ms": r.p95,
        "p99 ms": r.p99,
      });
    }
    const exportUrl = `/v1/exports/daily-attendance?date=${WORK_DATE}&format=xlsx`;
    const exp = await pool(6, 2, timed(exportUrl).bind(null)).catch((e: Error) => ({
      n: 0,
      rps: 0,
      p50: -1,
      p95: -1,
      p99: -1,
      err: e.message,
    }));
    rows.push({
      endpoint: `GET ${exportUrl.slice(0, 40)}… (${EMPLOYEES} rows)`,
      requests: 6,
      concurrency: 2,
      "req/s": exp.rps,
      "p50 ms": exp.p50,
      "p95 ms": exp.p95,
      "p99 ms": exp.p99,
    });
    console.log(`\n${EMPLOYEES} employees, ${REQUESTS} requests per endpoint\n`);
    console.table(rows);
  }, 600_000);

  it("prints latency for phone event uploads (POST /v1/events)", async () => {
    const DEVICES = Number(process.env.PERF_DEVICES ?? 100);
    const k = attendanceKit(h);
    const w = await k.world();
    // Each phone is an employee with a signed consent, a login and a registered device.
    const tokens: string[] = [];
    for (let i = 0; i < DEVICES; i += 1) {
      const e = await createEmployeeWithUser(h, w.tenant, `phone${i}`);
      await signConsentSql(h, w.tenant.id, e.employee.id);
      const t = (await signIn(h, e.user)).accessToken;
      await w.register(t);
      tokens.push(t);
    }
    const uid = () => `perf-${Math.random().toString(36).slice(2, 14)}`;
    const upload = async (token: string, events: object[]) => {
      const t = performance.now();
      const res = await h
        .http()
        .post("/v1/events")
        .set("Authorization", `Bearer ${token}`)
        .send({ events });
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`events -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      }
      return performance.now() - t;
    };
    const event = (type: "ENTER" | "EXIT", ageMs = 0) => ({
      clientEventId: uid(),
      type,
      locationId: w.locationId,
      ageMs,
      accuracyM: 12,
    });
    const rows: Array<Record<string, unknown>> = [];
    const row = (name: string, c: number, r: Awaited<ReturnType<typeof pool>>) =>
      rows.push({
        scenario: name,
        requests: r.n,
        concurrency: c,
        "req/s": r.rps,
        "p50 ms": r.p50,
        "p95 ms": r.p95,
        "p99 ms": r.p99,
      });

    await upload(tokens[0]!, [event("ENTER")]); // warm up
    // 1. Morning rush: every phone sends one event, in rounds, 20 at a time.
    let round = 0;
    row(
      "one event per request (many phones)",
      CONCURRENCY,
      await pool(DEVICES * 4, CONCURRENCY, () => {
        const token = tokens[round % DEVICES]!;
        const type = Math.floor(round / DEVICES) % 2 === 0 ? "EXIT" : "ENTER";
        round += 1;
        return upload(token, [event(type)]);
      }),
    );
    // 2. Offline catch-up: one phone sends its queue of 50 events in one request.
    let batch = 0;
    row(
      "batch of 50 events (phone back online)",
      5,
      await pool(20, 5, () => {
        const token = tokens[(batch += 1) % DEVICES]!;
        return upload(
          token,
          Array.from({ length: 50 }, (_, i) =>
            event(i % 2 === 0 ? "ENTER" : "EXIT", (50 - i) * 60_000),
          ),
        );
      }),
    );
    // 3. A retry of events the server already has (idempotent).
    const same = [event("ENTER"), event("EXIT", 1000)];
    await upload(tokens[1]!, same);
    row(
      "retry of events already received",
      CONCURRENCY,
      await pool(DEVICES, CONCURRENCY, () => upload(tokens[1]!, same)),
    );
    console.log(`\n${DEVICES} phones (devices)\n`);
    console.table(rows);
  }, 900_000);
});
