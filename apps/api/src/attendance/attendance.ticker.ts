import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { AttendanceService } from "./attendance.service";

const TICK_MS = 60_000;

/**
 * Evaluates due days every minute (PRD 6.3: an employee with no arrival becomes NO_SHOW exactly at the cut-off).
 * A tick that is still running is not started again, and a failed tick is only logged: the next one repeats it,
 * because results are derived data.
 */
@Injectable()
export class AttendanceTicker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(AttendanceTicker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly attendance: AttendanceService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.run(), TICK_MS);
    void this.run();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const changed = await this.attendance.tick();
      if (changed > 0) this.log.log(`attendance tick: ${changed} status change(s)`);
    } catch (error) {
      this.log.error(
        `attendance tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
