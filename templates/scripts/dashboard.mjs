#!/usr/bin/env node
// Memory dashboard entry point. Imports the bundled dashboard server and starts it.
// Replaces dashboard-placeholder.mjs as of Phase 3 Slice 6.

import { createServer, makeVoyageClient } from "./dashboard-bundle.mjs";

const PORT = parseInt(process.env.MEMORY_DASHBOARD_PORT || "4410", 10);
const HOST = process.env.MEMORY_DASHBOARD_HOST || "127.0.0.1";
const VAULT_ROOT = process.env.MEMORY_INSTALL_ROOT
  ? `${process.env.MEMORY_INSTALL_ROOT}/vault`
  : "/root/memory-system/vault";
const DASHBOARD_DIST = process.env.MEMORY_DASHBOARD_DIST ||
  (process.env.MEMORY_INSTALL_ROOT
    ? `${process.env.MEMORY_INSTALL_ROOT}/dist/dashboard-ui`
    : new URL("../dist/dashboard-ui/", import.meta.url).pathname);

const apiKey = process.env.VOYAGE_API_KEY;
const voyageClient = apiKey ? makeVoyageClient({ apiKey }) : null;
console.log(
  `[${new Date().toISOString()}] dashboard voyage client ${
    voyageClient ? "initialized" : "unavailable"
  }`,
);

const server = await createServer({
  vaultRoot: VAULT_ROOT,
  port: PORT,
  host: HOST,
  voyageClient,
  dashboardDistRoot: DASHBOARD_DIST,
});
console.log(`[${new Date().toISOString()}] dashboard listening on http://${HOST}:${PORT} (vault=${VAULT_ROOT}, ui=${DASHBOARD_DIST})`);

const shutdown = async () => {
  console.log(`[${new Date().toISOString()}] shutting down`);
  await server.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
