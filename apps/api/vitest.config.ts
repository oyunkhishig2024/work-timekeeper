import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Database tests share one schema, so test files run one after another.
    fileParallelism: false,
    // Resets and migrates TEST_DATABASE_URL when it is set (see test/db/global-setup.ts).
    globalSetup: ["test/db/global-setup.ts"],
  },
});
