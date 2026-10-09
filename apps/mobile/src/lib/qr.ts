/**
 * The onboarding / replacement QR carries `tkw://register?token=<tenantId>.<random>` and nothing else: no personal data (PRD 5,
 * apps/api/src/devices/README.md). Returns the token, or null when the code is not ours.
 */
export function parseRegistrationQr(payload: string): string | null {
  const text = payload.trim();
  const match = /^tkw:\/\/register\?token=([A-Za-z0-9._~%-]{10,300})$/u.exec(text);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}
