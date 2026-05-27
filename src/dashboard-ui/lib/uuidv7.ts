export function decodeUuidV7Time(id: string): Date | null {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  if (hex[12]?.toLowerCase() !== "7") return null;

  const ms = parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}
