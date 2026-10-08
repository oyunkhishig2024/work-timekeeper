/**
 * `TRUST_PROXY` → the value Express' `trust proxy` setting expects: a hop count ("1"), or a list of addresses /
 * CIDRs / keywords ("loopback, 10.0.0.0/8").
 */
export function parseTrustProxy(value: string): number | string[] {
  const text = value.trim();
  if (/^\d+$/u.test(text)) return Number(text);
  const list = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return list.length > 0 ? list : 1;
}
