import type { Db } from "../database/database.service";

/**
 * Updates the given columns of one row and returns the previous values of exactly those columns
 * (for the audit log). Column names come from code, never from users; values are bound parameters.
 */
export async function updateColumns(
  db: Db,
  table: string,
  id: string,
  columns: Record<string, unknown>,
): Promise<{ before: Record<string, unknown>; changed: boolean }> {
  const names = Object.keys(columns);
  if (names.length === 0) return { before: {}, changed: false };
  const current = await db.query(
    `SELECT ${names.join(", ")} FROM ${table} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const before = (current.rows[0] ?? {}) as Record<string, unknown>;
  const same = (a: unknown, b: unknown) =>
    a instanceof Date || b instanceof Date ? String(a) === String(b) : a === b;
  const changedNames = names.filter((n) => !same(before[n], columns[n]));
  if (changedNames.length === 0) return { before: {}, changed: false };
  const sets = changedNames.map((n, i) => `${n} = $${i + 2}`).join(", ");
  await db.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [
    id,
    ...changedNames.map((n) => columns[n]),
  ]);
  return {
    before: Object.fromEntries(changedNames.map((n) => [n, before[n]])),
    changed: true,
  };
}

/** Escapes % and _ so user input is matched literally inside ILIKE. */
export const likeEscape = (value: string): string => value.replace(/[\\%_]/gu, (c) => `\\${c}`);
