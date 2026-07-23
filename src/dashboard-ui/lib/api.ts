export const API_BASE = "/memory/api";

let dashboardAccessToken: string | undefined;

/**
 * Keep an operator-supplied remote dashboard token in this browser process
 * only. It intentionally never reaches URL parameters, config, or web storage.
 */
export function setDashboardAccessToken(token: string | undefined): void {
  dashboardAccessToken = token?.trim() || undefined;
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (dashboardAccessToken) {
    headers.set("Authorization", `Bearer ${dashboardAccessToken}`);
  }
  return fetch(input, { ...init, headers });
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const response = await apiFetch(url.toString());
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error bodies keep the status text fallback.
    }
    throw new ApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      message?: string;
      errors?: Array<{ path?: string; message?: string }>;
    };
    const fieldError = error.errors?.[0];
    const message = error.error ||
      error.message ||
      (fieldError ? `${fieldError.path}: ${fieldError.message}` : response.statusText);
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      message?: string;
      errors?: Array<{ path?: string; message?: string }>;
    };
    const fieldError = error.errors?.[0];
    const message = error.error ||
      error.message ||
      (fieldError ? `${fieldError.path}: ${fieldError.message}` : response.statusText);
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(response.status, error.error || error.message || response.statusText);
  }
  return response.json() as Promise<T>;
}
