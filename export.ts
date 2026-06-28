import { sourceByName } from "./sources/index.ts";
import type { Session, ToolCall, Turn } from "./sources/types.ts";

function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.path === "string") parts.push(record.path);
  if (typeof record.command === "string") {
    const cmd = record.command.replace(/\s+/g, " ").trim();
    parts.push(cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd);
  }
  if (typeof record.pattern === "string") parts.push(`pattern=${record.pattern}`);
  if (typeof record.glob_pattern === "string") parts.push(record.glob_pattern);
  if (typeof record.target_directory === "string") parts.push(record.target_directory);
  if (typeof record.description === "string" && parts.length === 0) parts.push(record.description);
  return parts.join(" · ") || name;
}

export function formatToolCall(tool: ToolCall): string {
  const detail = summarizeToolInput(tool.name, tool.input);
  return detail ? `${tool.name}(${detail})` : tool.name;
}

export interface SessionSummary {
  id: string;
  tool: string;
  dir: string;
  title: string;
  firstPrompt: string;
  start: number;
  end: number;
  msgCount: number;
  file: string;
  durationMs: number;
}

export interface SessionExport extends SessionSummary {
  resume: { argv: string[]; shell: string };
  transcript?: Turn[];
}

export function formatTurnLines(turn: Turn, opts: { truncate?: number } = {}): string[] {
  const lines: string[] = [];
  const text = opts.truncate && turn.text.length > opts.truncate
    ? `${turn.text.slice(0, opts.truncate)}…`
    : turn.text;
  if (text) lines.push(text);
  for (const tool of turn.tools ?? []) {
    lines.push(`→ ${formatToolCall(tool)}`);
  }
  return lines;
}

export function sessionSummary(s: Session): SessionSummary {
  return {
    id: s.id,
    tool: s.tool,
    dir: s.dir,
    title: s.title,
    firstPrompt: s.firstPrompt,
    start: s.start,
    end: s.end,
    msgCount: s.msgCount,
    file: s.file,
    durationMs: Math.max(0, s.end - s.start),
  };
}

export function sessionExport(s: Session, opts: { transcript?: boolean } = {}): SessionExport {
  const src = sourceByName(s.tool);
  const resume = src ? src.resume(s) : { argv: [], shell: "" };
  const out: SessionExport = {
    ...sessionSummary(s),
    resume: { argv: resume.argv, shell: resume.shell },
  };
  if (opts.transcript) {
    out.transcript = src?.transcript?.(s) ?? [];
  }
  return out;
}
