import "reflect-metadata";
import { isIP } from "node:net";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DatabaseModule } from "../database/database.module";
import { IpBlockStore } from "../security/ip-block.store";

@Module({ imports: [DatabaseModule], providers: [IpBlockStore] })
class CliModule {}

const USAGE = `Usage:
  ip-blocks list [--ip <addr>] [--limit 50]       recent blocks (all, or one address)
  ip-blocks block <addr> [--minutes 60] [--reason "<text>"]   block an address by hand
  ip-blocks unblock <addr> [--by <name>]          lift every block in force for an address
A running API picks changes up within about 30 seconds.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Operator tool for the temporary IP blocks written by the abuse protection (apps/api/src/security). */
async function main(): Promise<void> {
  const [command, address] = process.argv.slice(2);
  if (!command || !["list", "block", "unblock"].includes(command)) {
    console.error(USAGE);
    process.exit(2);
  }
  const needsAddress = command !== "list";
  if (needsAddress && (!address || isIP(address) === 0)) {
    console.error(`"${address ?? ""}" is not an IP address.\n${USAGE}`);
    process.exit(2);
  }
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ["error"] });
  try {
    const store = app.get(IpBlockStore);
    const now = new Date();
    if (command === "list") {
      const rows = await store.history(arg("ip") ?? null, Number(arg("limit") ?? 50));
      for (const r of rows) {
        const state = r.liftedAt
          ? `lifted by ${r.liftedBy}`
          : r.expiresAt > now
            ? "ACTIVE"
            : "expired";
        console.log(
          `${r.ip.padEnd(40)} strike ${r.strike}  until ${r.expiresAt.toISOString()}  ${state}  ${r.reason}`,
        );
      }
      if (rows.length === 0) console.log("No blocks.");
    } else if (command === "block") {
      const until = await store.manualBlock(
        address!,
        Number(arg("minutes") ?? 60),
        arg("reason") ?? "blocked by operator",
        now,
      );
      console.log(`${address} blocked until ${until.toISOString()}`);
    } else {
      const lifted = await store.lift(address!, arg("by") ?? "operator", now);
      console.log(
        lifted === 0
          ? `${address} had no active block.`
          : `${address} unblocked (${lifted} block(s) lifted).`,
      );
    }
  } finally {
    await app.close();
  }
}

void main();
