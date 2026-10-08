import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { delimiter, join } from "node:path";

/** Finds the redis-server binary (REDIS_SERVER_BIN, /usr/bin, PATH). Null when there is none. */
export function findRedisServer(): string | null {
  const candidates = [
    process.env.REDIS_SERVER_BIN,
    "/usr/bin/redis-server",
    ...(process.env.PATH ?? "").split(delimiter).map((d) => join(d, "redis-server")),
  ];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!)) ?? null;
}

export const redisBinary = findRedisServer();
export const hasRedis = redisBinary !== null;
if (!hasRedis)
  console.warn(
    "[tests] redis-server not found (set REDIS_SERVER_BIN or install redis): the shared-state (Redis) abuse tests are SKIPPED",
  );

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function ping(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let answer = "";
    socket.setTimeout(500, () => socket.destroy());
    socket.once("error", () => resolve(false));
    socket.once("close", () => resolve(answer.includes("PONG")));
    socket.connect(port, "127.0.0.1", () => socket.write("PING\r\n"));
    socket.on("data", (d) => {
      answer += d.toString();
      socket.destroy();
    });
  });
}

export interface TestRedis {
  port: number;
  url: string;
  /** Kills the server (no graceful shutdown): what a crash looks like to the clients. */
  kill: () => Promise<void>;
  /** Starts it again on the same port, empty (no persistence). */
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/** A throwaway redis-server on a random free port: no persistence, loopback only. */
export async function startRedis(): Promise<TestRedis> {
  if (!redisBinary) throw new Error("redis-server not found");
  const port = await freePort();
  let child: ChildProcess | null = null;
  const start = async () => {
    child = spawn(
      redisBinary,
      ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100; i++) {
      if (await ping(port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`redis-server did not start on port ${port}`);
  };
  const kill = async () => {
    const current = child;
    child = null;
    if (!current || current.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      current.once("exit", () => resolve());
      current.kill("SIGKILL");
    });
  };
  await start();
  return { port, url: `redis://127.0.0.1:${port}`, kill, start, stop: kill };
}
