import { tmpdir } from "node:os";

// Test configuration. Must run before application modules are imported (some read env at import time).
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "test-jwt-secret-test-jwt-secret-test-jwt-secret";
process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.AUTH_RATE_LIMIT_PER_MINUTE ??= "100000";
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.STORAGE_DIR ??= `${tmpdir()}/timekeeper-test-storage-${process.pid}`;
