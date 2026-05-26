export type SnifferSource =
  | "claude-code"
  | "antigravity"
  | "claude-desktop"
  | "vscode"
  | "codex";

export interface Closable {
  close: () => void | Promise<void>;
}

export interface ListOpts {
  since?: Date;
  limit?: number;
}

export interface RawSession {
  source: SnifferSource;
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  cwd?: string;
  body: string;
  rawSource?: unknown;
}

export interface Sniffer {
  name: string;
  available: () => Promise<boolean>;
  list: (opts: ListOpts) => AsyncIterable<RawSession>;
  watch?: (handler: (session: RawSession) => void) => Closable;
}
