import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { NotificationsService } from "./notifications.service";

const TICK_MS = 15_000;

/** Pushes due notifications every 15 seconds; a failed round is only logged, the next one repeats it. */
@Injectable()
export class NotificationTicker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(NotificationTicker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly notifications: NotificationsService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.run(), TICK_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sent = await this.notifications.dispatchDue();
      if (sent > 0) this.log.log(`pushed ${sent} notification(s)`);
    } catch (error) {
      this.log.error(
        `notification dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
