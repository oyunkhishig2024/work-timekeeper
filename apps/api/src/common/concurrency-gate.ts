import { ApiError } from "./api-error";

/**
 * Lets at most `max` jobs of one kind run at the same time in this process; the next one is refused with 429 and a hint when to
 * try again, instead of queueing up and slowing everybody else. Used for heavy work done inside a request (report exports).
 */
export class ConcurrencyGate {
  private running = 0;

  constructor(
    private readonly max: number,
    private readonly busy: { code: string; detail: string; retryAfterSeconds: number },
  ) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      throw new ApiError(429, this.busy.code, this.busy.detail, {
        retryAfterSeconds: this.busy.retryAfterSeconds,
      });
    }
    this.running += 1;
    try {
      return await job();
    } finally {
      this.running -= 1;
    }
  }

  get active(): number {
    return this.running;
  }
}
