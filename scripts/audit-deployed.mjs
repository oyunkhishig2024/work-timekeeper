// Dependency audit for what runs on the server and in the browser. Fails (exit 1) on a high or critical advisory that reaches
// the API, the worker, the web app or the shared packages. Advisories reachable only through apps/mobile (Expo build tools,
// which run on the build machine and never on the server) are listed but do not fail the check.
//   node scripts/audit-deployed.mjs
import { spawnSync } from "node:child_process";

const run = spawnSync("pnpm", ["audit", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(
    "Could not read the audit result (is the registry reachable?):\n" +
      (run.stderr || run.stdout).slice(0, 500),
  );
  process.exit(2);
}

const serious = new Set(["high", "critical"]);
const blocking = [];
const mobileOnly = [];
for (const advisory of Object.values(report.advisories ?? {})) {
  if (!serious.has(advisory.severity)) continue;
  const paths = advisory.findings.flatMap((f) => f.paths);
  const outside = paths.filter((p) => !p.startsWith("apps__mobile>"));
  const line = `${advisory.severity} ${advisory.module_name} (${advisory.url ?? advisory.github_advisory_id ?? advisory.id})`;
  (outside.length > 0 ? blocking : mobileOnly).push(
    `${line}\n    e.g. ${outside[0] ?? paths[0] ?? "?"}`,
  );
}

if (mobileOnly.length > 0) {
  console.log(
    `Not blocking (only reachable through the phone app's build tools): ${mobileOnly.length}`,
  );
  for (const l of mobileOnly) console.log("  " + l);
}
if (blocking.length > 0) {
  console.error(
    `High or critical advisories in what runs on the server or in the browser: ${blocking.length}`,
  );
  for (const l of blocking) console.error("  " + l);
  process.exit(1);
}
console.log("No high or critical advisories in the server, worker, web app or shared packages.");
