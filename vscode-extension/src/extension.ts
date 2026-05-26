import * as vscode from "vscode";
import { captureTurn } from "./capture";

export function activate(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    "memory-fort.memory",
    async (request, _context, stream) => {
      const sessionId = request.location?.toString?.() ?? Date.now().toString(36);
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

  const chatApi = vscode.chat as unknown as {
    onDidReceiveChatRequest?: (
      handler: (event: { prompt?: string; message?: string; sessionId?: string }) => void,
    ) => vscode.Disposable;
  };
  if (typeof chatApi.onDidReceiveChatRequest === "function") {
    context.subscriptions.push(
      chatApi.onDidReceiveChatRequest((event) => {
        captureTurn({
          sessionId: event.sessionId ?? Date.now().toString(36),
          prompt: event.prompt ?? event.message,
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        });
      }),
    );
  }
}

export function deactivate(): void {}
