import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ResumePlan, Session, Source, ToolCall, Turn } from "./types.ts";

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function collectJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  }
  return out;
}

function clean(text: unknown): string {
  return typeof text === "string" ? text.trim() : "";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return record.type === "input_text" || record.type === "output_text"
        ? clean(record.text)
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function appendTool(turns: Turn[], tool: ToolCall): void {
  const previous = turns[turns.length - 1];
  if (previous?.role === "assistant") {
    previous.tools = [...(previous.tools ?? []), tool];
    return;
  }
  turns.push({ role: "assistant", text: "", tools: [tool] });
}

function transcriptFrom(records: any[]): Turn[] {
  const hasUserEvents = records.some(
    (record) => record.type === "event_msg" && record.payload?.type === "user_message"
  );
  const hasAgentEvents = records.some(
    (record) => record.type === "event_msg" && record.payload?.type === "agent_message"
  );
  const turns: Turn[] = [];

  for (const record of records) {
    const payload = record.payload ?? {};
    if (record.type === "event_msg") {
      if (payload.type === "user_message") {
        const text = clean(payload.message);
        if (text) turns.push({ role: "user", text });
      } else if (payload.type === "agent_message") {
        const text = clean(payload.message);
        if (text) turns.push({ role: "assistant", text });
      } else if (payload.type === "mcp_tool_call_end" && payload.invocation) {
        const invocation = payload.invocation;
        const server = clean(invocation.server);
        const tool = clean(invocation.tool);
        appendTool(turns, {
          name: [server, tool].filter(Boolean).join(".") || "mcp",
          input: invocation.arguments,
        });
      }
      continue;
    }

    if (record.type !== "response_item") continue;
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      if (
        (payload.role === "user" && hasUserEvents) ||
        (payload.role === "assistant" && hasAgentEvents)
      ) {
        continue;
      }
      const text = messageText(payload.content);
      if (text) turns.push({ role: payload.role, text });
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      appendTool(turns, {
        name: clean(payload.name) || payload.type,
        input: parseInput(payload.arguments ?? payload.input),
      });
    } else if (payload.type === "tool_search_call") {
      appendTool(turns, {
        name: "tool_search",
        input: parseInput(payload.arguments),
      });
    } else if (payload.type === "web_search_call") {
      appendTool(turns, {
        name: "web_search",
        input: payload.action ?? payload,
      });
    }
  }

  return turns;
}

let titleCache:
  | { path: string; key: string; titles: Map<string, string> }
  | undefined;

function titleIndexKey(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function loadTitles(): Map<string, string> {
  const path = join(codexHome(), "session_index.jsonl");
  const key = titleIndexKey(path);
  if (titleCache?.path === path && titleCache.key === key) return titleCache.titles;

  const titles = new Map<string, string>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const id = clean(entry.id);
        const title = oneLine(clean(entry.thread_name));
        if (id && title) titles.set(id, title);
      } catch {
        continue;
      }
    }
  } catch {
    // The index is optional; older Codex installs may not have one.
  }
  titleCache = { path, key, titles };
  return titles;
}

function readRecords(file: string): any[] | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const records: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

export const codex: Source = {
  name: "codex",

  available() {
    const home = codexHome();
    return existsSync(join(home, "sessions")) || existsSync(join(home, "archived_sessions"));
  },

  files() {
    const home = codexHome();
    return [
      ...collectJsonl(join(home, "sessions")),
      ...collectJsonl(join(home, "archived_sessions")),
    ];
  },

  cacheKey() {
    const path = join(codexHome(), "session_index.jsonl");
    return `${path}:${titleIndexKey(path)}`;
  },

  parse(file: string): Session | null {
    const records = readRecords(file);
    if (!records) return null;

    const meta = records.find((record) => record.type === "session_meta")?.payload;
    if (!meta) return null;

    // These are the same interactive sources Codex itself shows in its default
    // resume picker. Exec, MCP, internal, and subagent rollouts are omitted.
    const source = meta.source ?? "vscode";
    if (source !== "cli" && source !== "vscode") return null;

    const filenameId = basename(file).match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    )?.[1];
    const id = clean(meta.id) || clean(meta.session_id) || filenameId || "";
    if (!id) return null;

    let min = Infinity;
    let max = 0;
    for (const record of records) {
      for (const value of [record.timestamp, record.type === "session_meta" && record.payload?.timestamp]) {
        if (typeof value !== "string") continue;
        const timestamp = Date.parse(value);
        if (Number.isNaN(timestamp)) continue;
        if (timestamp < min) min = timestamp;
        if (timestamp > max) max = timestamp;
      }
    }

    const stat = statSync(file);
    const turns = transcriptFrom(records);
    const firstPrompt =
      turns.find((turn) => turn.role === "user" && turn.text)?.text ?? "";
    const shortPrompt = oneLine(firstPrompt);
    const title =
      loadTitles().get(id) ||
      (shortPrompt ? shortPrompt.slice(0, 70) : "(untitled session)");

    return {
      tool: "codex",
      id,
      dir: clean(meta.cwd) || "(unknown)",
      title,
      firstPrompt: shortPrompt.slice(0, 240),
      start: Number.isFinite(min) ? min : stat.mtimeMs,
      end: max || stat.mtimeMs,
      msgCount: turns.filter((turn) => Boolean(turn.text)).length,
      file,
    };
  },

  resume(session: Session): ResumePlan {
    return {
      argv: ["codex", "resume", session.id],
      shell: `cd ${shq(session.dir)} && codex resume ${session.id}`,
    };
  },

  transcript(session: Session): Turn[] {
    const records = readRecords(session.file);
    return records ? transcriptFrom(records) : [];
  },
};

function shq(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
