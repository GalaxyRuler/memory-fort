export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function readPageSize(value: unknown): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : DEFAULT_PAGE_SIZE;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_PAGE_SIZE ? parsed : DEFAULT_PAGE_SIZE;
}
