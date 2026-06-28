import { homedir } from "node:os";
import { basename } from "node:path";
import { sourceByName } from "./sources/index.ts";
import { formatToolCall } from "./export.ts";
import type { Session, Turn } from "./sources/types.ts";

const HOME = homedir();

export interface CompactOptions {
  maxChars: number;
  toolsOnly: boolean;
  collapseTools: boolean;
  shortPaths: boolean;
  includeResume: boolean;
}

export function parseCompactOptions(flags: Record<string, string | boolean>): CompactOptions {
  const compact = Boolean(flags.compact);
  const digest = flags.format === "digest";
  const tuned = compact || digest;
  const maxRaw = typeof flags["max-chars"] === "string" ? Number(flags["max-chars"]) : NaN;
  return {
    maxChars: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : tuned ? 280 : 0,
    toolsOnly: Boolean(flags["tools-only"]),
    collapseTools: flags["no-collapse"] ? false : tuned || Boolean(flags["collapse-tools"]),
    shortPaths: tuned || Boolean(flags["short-paths"]),
    includeResume: Boolean(flags.resume),
  };
}

export function shortenPath(path: string, shortPaths: boolean): string {
  if (!shortPaths || path === "(unknown)") return path;
  if (path.startsWith(HOME)) return "~" + path.slice(HOME.length);
  return path;
}

function truncate(text: string, maxChars: number): string {
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function basenamePath(path: string): string {
  return path.includes("/") ? basename(path) : path;
}

export function compactToolCall(tool: { name: string; input: unknown }, shortPaths: boolean): string {
  if (!shortPaths) return formatToolCall(tool);
  if (typeof tool.input !== "object" || tool.input === null) return tool.name;
  const input = { ...(tool.input as Record<string, unknown>) };
  if (typeof input.path === "string") input.path = basenamePath(input.path);
  if (typeof input.target_directory === "string") {
    input.target_directory = shortenPath(input.target_directory, true);
  }
  return formatToolCall({ name: tool.name, input });
}

export function compactTurnLine(turn: Turn, opts: CompactOptions): string | null {
  const prefix = turn.role === "user" ? "U" : "A";
  const parts: string[] = [];

  if (!opts.toolsOnly || turn.role === "user") {
    const text = truncate(turn.text.trim(), opts.maxChars);
    if (text) parts.push(text);
  }

  for (const tool of turn.tools ?? []) {
    parts.push(compactToolCall(tool, opts.shortPaths));
  }

  if (parts.length === 0) return null;
  return `${prefix}: ${parts.join(" | ")}`;
}

export function collapseTurns(turns: Turn[], opts: CompactOptions): Turn[] {
  if (!opts.collapseTools) return turns;

  const out: Turn[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    const toolOnly = !turn.text.trim() && (turn.tools?.length ?? 0) > 0;
    const prevToolOnly = prev && !prev.text.trim() && (prev.tools?.length ?? 0) > 0;

    if (toolOnly && prevToolOnly && prev.role === turn.role) {
      prev.tools = [...(prev.tools ?? []), ...(turn.tools ?? [])];
      continue;
    }
    out.push({
      role: turn.role,
      text: turn.text,
      tools: turn.tools ? [...turn.tools] : undefined,
    });
  }
  return out;
}

export interface CompactCatalogEntry {
  id: string;
  tool: string;
  dir: string;
  title: string;
  msgs: number;
  end: string;
  prompt: string;
}

export function compactCatalogEntry(s: Session, opts: CompactOptions): CompactCatalogEntry {
  return {
    id: s.id,
    tool: s.tool,
    dir: shortenPath(s.dir, opts.shortPaths),
    title: s.title,
    msgs: s.msgCount,
    end: new Date(s.end).toISOString().slice(0, 10),
    prompt: truncate(s.firstPrompt, opts.maxChars || 160),
  };
}

export function sessionDigest(s: Session, opts: CompactOptions): string {
  const src = sourceByName(s.tool);
  const raw = src?.transcript?.(s) ?? [];
  const turns = collapseTurns(raw, opts);
  const mins = Math.max(1, Math.round((s.end - s.start) / 60_000));

  const lines = [
    `# ${s.title}`,
    `id:${s.id} | ${s.tool} | ${shortenPath(s.dir, opts.shortPaths)} | ${s.msgCount} turns | ${mins}m`,
  ];

  const prompt = truncate(s.firstPrompt.trim(), opts.maxChars || 320);
  if (prompt) lines.push(`> ${prompt.replace(/\n+/g, " ")}`, "");

  lines.push("## timeline");
  for (const turn of turns) {
    const line = compactTurnLine(turn, opts);
    if (line) lines.push(line);
  }

  if (opts.includeResume && src) {
    lines.push("", `resume: ${src.resume(s).shell}`);
  }

  return lines.join("\n");
}

export function exportCompactJson(
  sessions: Session[],
  opts: CompactOptions,
  withTranscript: boolean
): string {
  if (!withTranscript) {
    return JSON.stringify(sessions.map((s) => compactCatalogEntry(s, opts)));
  }

  const payload = sessions.map((s) => {
    const src = sourceByName(s.tool);
    const turns = collapseTurns(src?.transcript?.(s) ?? [], opts)
      .map((t) => compactTurnLine(t, opts))
      .filter((line): line is string => Boolean(line));
    return { ...compactCatalogEntry(s, opts), timeline: turns };
  });
  return JSON.stringify(payload);
}
