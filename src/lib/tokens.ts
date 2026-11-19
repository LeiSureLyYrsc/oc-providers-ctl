/**
 * Token counts are stored as plain integers. Input is tolerant of the group
 * separators people actually type (`262,144` / `262 144`), but anything that
 * is not a whole non-negative number is rejected rather than rounded.
 */
export function parseTokenInput(value: string): number | null | 'invalid' {
  const compact = value.trim().replace(/[\s,_，]/g, '');
  if (!compact) return null;
  if (!/^\d+$/.test(compact)) return 'invalid';
  const parsed = Number(compact);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

export function tokenInputValue(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}
