import { claude } from "./claude.ts";
import { opencode } from "./opencode.ts";
import { omp } from "./omp.ts";
import { copilotVscode } from "./copilot-vscode.ts";
import type { Source } from "./types.ts";

// Register tools here. Each must implement the Source interface.
// Add codex / gemini / cursor sources to this list to extend coverage.
export const SOURCES: Source[] = [claude, opencode, omp, copilotVscode];

export function sourceByName(name: string): Source | undefined {
  return SOURCES.find((s) => s.name === name);
}
