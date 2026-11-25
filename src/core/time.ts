export function asDate(iso: string | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

export function ageDays(iso: string, now = Date.now()): number {
  const time = asDate(iso);
  if (time === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - time) / 86_400_000);
}

export function formatAge(days: number): string {
  if (!Number.isFinite(days)) return "unknown";
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  if (days < 30) return `${Math.round(days)}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}
