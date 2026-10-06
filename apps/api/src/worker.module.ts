import { Module } from "@nestjs/common";

/**
 * Worker process root module (no HTTP server). Job handlers and schedulers
 * (evaluate-due-days, materialize-expected-days, retention, ...) are registered here;
 * see docs/Timekeeper_Work_Architecture.md Section 6.6.
 */
@Module({})
export class WorkerModule {}
