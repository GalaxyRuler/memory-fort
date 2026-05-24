export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const sec = Math.round((now.getTime() - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.round(month / 12)}y ago`;
}

export function timestampToX(timestamp: string, from: string, to: string, width: number): number {
  const valueMs = new Date(timestamp).getTime();
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (toMs === fromMs) return 0;
  return ((valueMs - fromMs) / (toMs - fromMs)) * width;
}
