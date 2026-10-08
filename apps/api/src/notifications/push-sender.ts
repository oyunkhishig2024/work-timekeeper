import { Inject, Injectable } from "@nestjs/common";
import webpush from "web-push";
import { APP_CONFIG, type AppConfig } from "../common/config";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string | null;
  tag: string;
  notificationId: string;
}

/** The push service answered with an HTTP status (404 / 410 mean the subscription is gone). */
export class PushDeliveryError extends Error {
  constructor(
    readonly statusCode: number | null,
    message: string,
  ) {
    super(message);
  }
  get gone(): boolean {
    return this.statusCode === 404 || this.statusCode === 410;
  }
}

/** Sends one Web Push message. `enabled` is false when no VAPID keys are configured. */
export abstract class PushSender {
  abstract readonly enabled: boolean;
  abstract publicKey(): string | null;
  abstract send(target: PushTarget, payload: PushPayload): Promise<void>;
}

@Injectable()
export class WebPushSender extends PushSender {
  readonly enabled: boolean;
  private readonly vapid: { subject: string; publicKey: string; privateKey: string } | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.vapid =
      config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
        ? {
            subject: config.VAPID_SUBJECT,
            publicKey: config.VAPID_PUBLIC_KEY,
            privateKey: config.VAPID_PRIVATE_KEY,
          }
        : null;
    this.enabled = this.vapid !== null;
  }

  publicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<void> {
    if (!this.vapid) throw new PushDeliveryError(null, "Web Push is not configured.");
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        { vapidDetails: this.vapid, TTL: 24 * 3600, timeout: 10_000, urgency: "high" },
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? null;
      throw new PushDeliveryError(status, error instanceof Error ? error.message : "Push failed");
    }
  }
}

/**
 * Only the known browser push services may be a subscription's endpoint: the server posts to that URL, so an arbitrary
 * one would let a user make the API call internal addresses. `patterns` are hosts or `*.suffix`.
 */
export function isAllowedPushEndpoint(endpoint: string, patterns: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return patterns
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .some((p) =>
      p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p,
    );
}

/** Minutes to wait after the n-th failed attempt (1-based); null = give up. */
export function pushRetryDelayMinutes(attempt: number): number | null {
  const delays = [1, 5, 30, 120];
  return attempt <= delays.length ? delays[attempt - 1]! : null;
}
