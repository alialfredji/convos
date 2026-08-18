import { claude } from "./claude.ts";
import { opencode } from "./opencode.ts";
import { omp } from "./omp.ts";
import { copilotCli } from "./copilot-cli.ts";
import { copilotVscode } from "./copilot-vscode.ts";
import { cursor } from "./cursor.ts";
import { codex } from "./codex.ts";
import type { Source } from "./types.ts";

// Register tools here. Each must implement the Source interface.
// Add new sources to this list to extend coverage.
export const SOURCES: Source[] = [
  claude,
  opencode,
  omp,
  copilotCli,
  copilotVscode,
  cursor,
  codex,
];

export function sourceByName(name: string): Source | undefined {
  return SOURCES.find((s) => s.name === name);
}
