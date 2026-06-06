#!/usr/bin/env node
// Placeholder dashboard for Phase 3 Slice 4.
// Replaced by the real dashboard in Slice 6.

import { createServer } from "node:http";

const PORT = 4410;
const HOST = "127.0.0.1";

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Memory dashboard placeholder</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #333;">
<h1>Memory dashboard</h1>
<p>This is a placeholder. The real dashboard ships in Phase 3 Slice 6.</p>
<p>Install info: <code>${process.env.MEMORY_INSTALL_ROOT || "(MEMORY_INSTALL_ROOT not set)"}</code></p>
<p>Healthcheck: <a href="/healthz"><code>/healthz</code></a></p>
</body>
</html>`);
});

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] dashboard placeholder listening on http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log(`[${new Date().toISOString()}] SIGTERM received; shutting down`);
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log(`[${new Date().toISOString()}] SIGINT received; shutting down`);
  server.close(() => process.exit(0));
});
