const DAY_MS = 24 * 60 * 60 * 1000;

export function formatRelative(iso: string, now: Date = new Date()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;

  const diffDays = Math.max(0, Math.floor((now.getTime() - parsed) / DAY_MS));
  if (diffDays === 0) return "today";
  if (diffDays < 7) return `${diffDays}d ago`;

  const weeks = Math.floor(diffDays / 7);
  if (weeks < 8) return `${weeks}w ago`;

  const months = Math.floor(diffDays / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(diffDays / 365);
  return `${years}y ago`;
}
