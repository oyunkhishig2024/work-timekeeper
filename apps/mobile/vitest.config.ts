import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The logic of the app (API client, outbox, sync, plan, health, history) is plain TypeScript and is tested in Node;
// the screens and the native geofencing bridge need a device and are not tested here.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
