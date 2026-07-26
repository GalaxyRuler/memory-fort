export function hasArchivePathComponent(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((component) => {
      const normalized = component.toLowerCase();
      return normalized === "archive" || normalized === "_archive";
    });
}
