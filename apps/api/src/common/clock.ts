/** Injectable time source so time-dependent logic (lockout, TOTP, expiry) is testable. */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
