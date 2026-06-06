export interface AntigravityHookTemplate {
  hook: string;
  sectionTitle: string;
}

export function defineHook(
  hook: string,
  sectionTitle: string,
): AntigravityHookTemplate {
  return { hook, sectionTitle };
}
