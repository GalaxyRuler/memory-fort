export type SecretProvider = "voyage" | "openai" | "openrouter";

export interface ValidateResult {
  ok: boolean;
  message?: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

interface Probe {
  url: string;
  method: "GET" | "POST";
  headers: (key: string) => Record<string, string>;
  body?: string;
}

const PROBES: Record<SecretProvider, Probe> = {
  voyage: {
    url: "https://api.voyageai.com/v1/embeddings",
    method: "POST",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    body: JSON.stringify({ input: ["ping"], model: "voyage-3-lite" }),
  },
  openai: {
    url: "https://api.openai.com/v1/embeddings",
    method: "POST",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    body: JSON.stringify({ input: "ping", model: "text-embedding-3-small" }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/auth/key",
    method: "GET",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

export async function validateKey(
  provider: SecretProvider,
  key: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ValidateResult> {
  const probe = PROBES[provider];
  if (!probe) return { ok: false, message: `unknown provider: ${provider}` };
  if (!key || key.trim().length === 0) return { ok: false, message: "key is empty" };
  try {
    const res = await fetchImpl(probe.url, {
      method: probe.method,
      headers: probe.headers(key),
      ...(probe.body ? { body: probe.body } : {}),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "invalid or unauthorized API key" };
    }
    return { ok: false, message: `provider returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: `could not reach provider: ${(err as Error).message}` };
  }
}

/** Map a secrets env-var name to its provider. */
export function providerForKey(key: string): SecretProvider | null {
  if (key === "VOYAGE_API_KEY") return "voyage";
  if (key === "OPENAI_API_KEY") return "openai";
  if (key === "OPENROUTER_API_KEY") return "openrouter";
  return null;
}
