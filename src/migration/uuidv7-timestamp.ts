import { formatIsoDate } from "../storage/paths.js";

// Agentmemory keys have a UUIDv7 either as the suffix
//   mem:<scope>:<uuidv7>
// OR embedded mid-key:
//   mem:obs:<uuidv7>:obs_<extra-id>
//   mem:sessions:<uuidv7>
// Match the UUIDv7 wherever it appears in the key.
// Agentmemory keys have a UUIDv7 either as the suffix
//   mem:<scope>:<uuidv7>
// OR embedded mid-key:
//   mem:obs:<uuidv7>:obs_<extra-id>
//   mem:sessions:<uuidv7>
// Require the mem: prefix so arbitrary strings can't match.
const AGENTMEMORY_UUIDV7_KEY =
  /^mem:[a-z]+:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})(?::|$)/i;

export function uuidv7ToTimestamp(uuid: string): Date | null {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) return null;
  if (hex[12]?.toLowerCase() !== "7") return null;

  const ms = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function observedDateFromAgentMemoryKey(key: string): string | null {
  const match = AGENTMEMORY_UUIDV7_KEY.exec(key);
  if (!match) return null;
  const date = uuidv7ToTimestamp(match[1]!);
  return date ? formatIsoDate(date) : null;
}
