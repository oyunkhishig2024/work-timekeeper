import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // SWC emits decorator metadata, which NestJS dependency injection needs (esbuild does not).
  plugins: [
    swc.vite({
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Database tests share one schema, so test files run one after another.
    fileParallelism: false,
    // Resets and migrates TEST_DATABASE_URL when it is set (see test/db/global-setup.ts).
    globalSetup: ["test/db/global-setup.ts"],
    setupFiles: ["test/setup-env.ts"],
  },
});
