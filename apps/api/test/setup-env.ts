import { tmpdir } from "node:os";

// Test configuration. Must run before application modules are imported (some read env at import time).
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "test-jwt-secret-test-jwt-secret-test-jwt-secret";
process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.AUTH_RATE_LIMIT_PER_MINUTE ??= "100000";
if (process.env.TEST_DATABASE_URL) {
  // The application connects as the limited production login role tk_app, like the deployed API.
  const appUrl = new URL(process.env.TEST_DATABASE_URL);
  appUrl.username = "tk_app";
  appUrl.password = "tk_app_test";
  process.env.DATABASE_URL = appUrl.toString();
}
process.env.STORAGE_DIR ??= `${tmpdir()}/timekeeper-test-storage-${process.pid}`;
// The abuse protection has its own tests; every other test hits the API from one address with many deliberate errors.
process.env.ABUSE_PROTECTION ??= "off";
