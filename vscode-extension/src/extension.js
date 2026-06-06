"use strict";
const vscode = require("vscode");
const { captureTurn } = require("./capture");

function activate(context) {
  const participant = vscode.chat.createChatParticipant(
    "memory-fort.memory",
    async (request, _context, stream) => {
      const sessionId = request.location?.toString?.() || Date.now().toString(36);
      captureTurn({
        sessionId,
        prompt: request.prompt,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      });
      stream.markdown("Captured this turn in Memory Fort.");
    },
  );
  participant.iconPath = new vscode.ThemeIcon("database");
  context.subscriptions.push(participant);

  const chatApi = vscode.chat;
  if (typeof chatApi.onDidReceiveChatRequest === "function") {
    context.subscriptions.push(
      chatApi.onDidReceiveChatRequest((event) => {
        captureTurn({
          sessionId: event.sessionId || Date.now().toString(36),
          prompt: event.prompt || event.message,
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        });
      }),
    );
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
