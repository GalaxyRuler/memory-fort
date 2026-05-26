"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function captureTurn(turn) {
  const timestamp = turn.timestamp || new Date();
  const root = process.env.MEMORY_ROOT || path.join(os.homedir(), ".memory");
  const sessionId = safeName(turn.sessionId || "vscode");
  const file = path.join(root, "raw", isoDate(timestamp), `vscode-${sessionId}.md`);
  ensureFile(file, turn, timestamp);
  const time = timestamp.toISOString().slice(11, 19);
  if (turn.prompt && turn.prompt.trim()) {
    fs.appendFileSync(file, `\n## [${time}] Prompt\n\n${turn.prompt.trim()}\n`, "utf-8");
  }
  if (turn.response && turn.response.trim()) {
    fs.appendFileSync(file, `\n## [${time}] Response\n\n${turn.response.trim()}\n`, "utf-8");
  }
  return file;
}

function ensureFile(file, turn, timestamp) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const frontmatter = [
    "---",
    "source: vscode",
    `session_id: ${turn.sessionId}`,
    `created: ${isoDate(timestamp)}`,
    `updated: ${isoDate(timestamp)}`,
    turn.cwd ? `cwd: "${turn.cwd.replace(/"/g, '\\"')}"` : null,
    "---",
    "",
    `# VS Code Chat Session ${turn.sessionId}`,
    "",
  ].filter(Boolean).join("\n");
  fs.writeFileSync(file, frontmatter, "utf-8");
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "vscode";
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

module.exports = { captureTurn };
