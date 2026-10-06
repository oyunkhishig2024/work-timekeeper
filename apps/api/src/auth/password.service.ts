import { randomInt } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { ApiError } from "../common/api-error";

// OWASP minimum for Argon2id: 19 MiB memory, 2 iterations, 1 lane.
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Placeholder checked when the account does not exist, so timing does not reveal valid usernames.
let dummyHashPromise: Promise<string> | undefined;

/**
 * A short built-in denylist of the most common passwords. PRD 15.2 asks for a breached-password
 * check; checking against the full Have I Been Pwned list needs a call to an external service (a new
 * entry in the PRD 15.3 foreign processors register) and is not enabled yet.
 */
const COMMON_PASSWORDS = new Set(
  [
    "password",
    "password1",
    "password123",
    "passw0rd",
    "qwerty123",
    "qwertyuiop",
    "1234567890",
    "123456789",
    "12345678910",
    "1q2w3e4r5t",
    "iloveyou12",
    "admin12345",
    "administrator",
    "welcome123",
    "letmein123",
    "monkey1234",
    "abc1234567",
    "timekeeper",
    "timekeeper1",
    "changeme123",
    "temp123456",
    "mongolia123",
    "ulaanbaatar",
    "sainuu1234",
  ].map((p) => p.toLowerCase()),
);

const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Burn the same CPU as a real verification when there is no account to check. */
  async verifyDummy(password: string): Promise<void> {
    dummyHashPromise ??= hash("timekeeper-dummy-password", ARGON2_OPTIONS);
    await this.verify(await dummyHashPromise, password);
  }

  /** PRD 15.2: at least 10 characters, not a known-weak password. Throws a 400 with a reason code. */
  assertAcceptable(password: string, context: { username: string }): void {
    const problems: string[] = [];
    if (password.length < 10) problems.push("TOO_SHORT");
    if (password.length > 128) problems.push("TOO_LONG");
    const lowered = password.toLowerCase();
    if (COMMON_PASSWORDS.has(lowered)) problems.push("TOO_COMMON");
    if (lowered.includes(context.username.toLowerCase()) && context.username.length >= 3) {
      problems.push("CONTAINS_USERNAME");
    }
    if (/^(.)\1+$/u.test(password)) problems.push("REPEATED_CHARACTER");
    if (problems.length > 0) {
      throw new ApiError(
        400,
        "WEAK_PASSWORD",
        "The new password does not meet the password policy.",
        {
          reasons: problems,
        },
      );
    }
  }

  /** One-time password handed to a user by HR/admin; they must change it at first login. */
  generateTemporary(length = 16): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
    return out;
  }
}
