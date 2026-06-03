import { claude } from "./claude.ts";
import type { Source } from "./types.ts";

// Register tools here. Each must implement the Source interface.
// Add codex / opencode / gemini / cursor sources to this list to extend coverage.
export const SOURCES: Source[] = [claude];

export function sourceByName(name: string): Source | undefined {
  return SOURCES.find((s) => s.name === name);
}
