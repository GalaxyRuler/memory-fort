import { loadMemoryConfig, type MemoryConfig } from "../../../storage/config.js";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

export interface DashboardVerifyOptions extends VerifyCheckContext {
  dashboardUrl?: string;
  fetchFn?: typeof fetch;
  configLoader?: () => Promise<Pick<MemoryConfig, "dashboard" | "vps">>;
}

export interface VerifyDashboardStatus {
  lastCompile?: { timestamp: string; line?: string } | null;
  compile?: { history?: Array<{ status?: string; finishedAt?: string }> };
  [key: string]: unknown;
}

const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4410/memory";

export const dashboardStatusCheck: CheckDescriptor = {
  id: "dashboard.status",
  label: "dashboard /api/status",
  roles: ["operator", "server"],
  run: checkDashboard,
};

export async function resolveDashboardUrl(
  override?: string,
  configLoader: () => Promise<Pick<MemoryConfig, "dashboard" | "vps">> = loadMemoryConfig,
): Promise<string> {
  if (override) return trimTrailingSlash(override);
  const config = await configLoader();
  const dashboardUrl = config.dashboard?.url?.trim();
  if (dashboardUrl) return trimTrailingSlash(dashboardUrl);
  const host = config.vps?.host?.trim();
  return host ? `https://${host}/memory` : DEFAULT_DASHBOARD_URL;
}

export async function checkDashboard(
  opts: DashboardVerifyOptions,
): Promise<VerifyCheckResult & { statusBody?: VerifyDashboardStatus }> {
  if (opts.offline) {
    return warn(
      "dashboard.status",
      "dashboard /api/status skipped (--offline)",
    );
  }

  const baseUrl = await resolveDashboardUrl(opts.dashboardUrl, opts.configLoader);
  const url = `${baseUrl}/api/status`;
  try {
    const response = await (opts.fetchFn ?? fetch)(url);
    if (!response.ok) {
      return fail(
        "dashboard.status",
        "dashboard /api/status returns 200",
        "restart the dashboard service",
        `HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as VerifyDashboardStatus;
    if (!body || typeof body !== "object") {
      return fail(
        "dashboard.status",
        "dashboard /api/status returns valid JSON",
        "restart the dashboard service",
      );
    }
    return {
      ...pass("dashboard.status", "dashboard /api/status returns 200"),
      statusBody: body,
    };
  } catch (error) {
    return fail(
      "dashboard.status",
      "dashboard /api/status returns valid JSON",
      "restart the dashboard service",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
