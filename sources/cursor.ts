import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, sep } from "node:path";
import type { ResumePlan, Session, Source, Turn } from "./types.ts";

const ROOT = join(homedir(), ".cursor");
const PROJECTS = join(ROOT, "projects");
const resolvedPaths = new Map<string, string | null>();

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(" ");
  if (!isRecord(node)) return "";

  if (node.type === "tool_result" || node.type === "tool_use") return "";
  if (node.value !== undefined) return textOf(node.value);
  if (node.text !== undefined) return textOf(node.text);
  if (node.content !== undefined) return textOf(node.content);
  if (Array.isArray(node.parts)) return node.parts.map(textOf).filter(Boolean).join(" ");
  return "";
}

function userText(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return match ? match[1] : text;
}

function isMeta(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") || t.startsWith("Caveat:");
}

function clean(text: string): string {
  return text.replace(/^[❯>]\s*/, "").replace(/\s+/g, " ").trim();
}

function toEpoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function readJson(file: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cursorRootFor(file: string): string | null {
  const parts = file.split(sep);
  const projectsIndex = parts.lastIndexOf("projects");
  if (projectsIndex <= 0) return null;
  const root = parts.slice(0, projectsIndex).join(sep);
  return root || sep;
}

function projectKey(file: string): string | null {
  const parts = file.split(sep);
  const projectsIndex = parts.lastIndexOf("projects");
  const key = parts[projectsIndex + 1];
  return key || null;
}

function resolveEncodedAbsolutePath(encoded: string): string | null {
  if (encoded === "empty-window") return null;
  if (resolvedPaths.has(encoded)) return resolvedPaths.get(encoded) ?? null;

  function walk(dir: string, remaining: string): string | null {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort((a, b) => b.length - a.length);
    } catch {
      return null;
    }

    for (const entry of entries) {
      const candidate = join(dir, entry);
      if (remaining === entry) {
        try {
          return statSync(candidate).isDirectory() ? candidate : null;
        } catch {
          return null;
        }
      }
      if (!remaining.startsWith(`${entry}-`)) continue;
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      const resolved = walk(candidate, remaining.slice(entry.length + 1));
      if (resolved) return resolved;
    }
    return null;
  }

  const resolved = walk(sep, encoded);
  resolvedPaths.set(encoded, resolved);
  return resolved;
}

function workspaceDir(file: string): string {
  const key = projectKey(file);
  if (!key) return "(unknown)";
  return resolveEncodedAbsolutePath(key) ?? "(unknown)";
}

function sessionId(file: string): string {
  const dirId = basename(dirname(file));
  return dirId || basename(file, extname(file));
}

function metaFor(file: string, id: string): JsonRecord | null {
  const root = cursorRootFor(file);
  if (!root) return null;
  const chats = join(root, "chats");
  let chatRoots: string[];
  try {
    chatRoots = readdirSync(chats);
  } catch {
    return null;
  }

  for (const chatRoot of chatRoots) {
    const meta = join(chats, chatRoot, id, "meta.json");
    if (existsSync(meta)) return readJson(meta);
  }
  return null;
}

function transcriptTurns(file: string): Turn[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parsed = readLine(line);
    if (!parsed) continue;
    const role = parsed?.role;
    if (role !== "user" && role !== "assistant") continue;

    const rawText = textOf(parsed.message);
    const text = clean(role === "user" ? userText(rawText) : rawText);
    if (!text || isMeta(text)) continue;
    turns.push({ role, text });
  }
  return turns;
}

function readLine(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const cursor: Source = {
  name: "cursor",

  available() {
    return existsSync(PROJECTS);
  },

  files() {
    if (!existsSync(PROJECTS)) return [];
    const out: string[] = [];
    const seen = new Set<string>();

    for (const project of readdirSync(PROJECTS)) {
      const transcriptRoot = join(PROJECTS, project, "agent-transcripts");
      let sessionDirs: string[];
      try {
        sessionDirs = readdirSync(transcriptRoot);
      } catch {
        continue;
      }

      for (const sessionDir of sessionDirs) {
        const dir = join(transcriptRoot, sessionDir);
        const preferred = join(dir, `${sessionDir}.jsonl`);
        if (existsSync(preferred) && !seen.has(preferred)) {
          seen.add(preferred);
          out.push(preferred);
          continue;
        }

        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl")) continue;
          const file = join(dir, entry);
          if (seen.has(file)) continue;
          seen.add(file);
          out.push(file);
        }
      }
    }
    return out;
  },

  parse(file: string): Session | null {
    const id = sessionId(file);
    const meta = metaFor(file, id);
    const turns = transcriptTurns(file);
    const msgCount = turns.length;
    if (msgCount === 0 && meta?.hasConversation !== true) return null;

    const firstPrompt = turns.find((turn) => turn.role === "user")?.text.slice(0, 240) ?? "";
    const stat = statSync(file);
    const start = toEpoch(meta?.createdAtMs) ?? stat.mtimeMs;
    const end = toEpoch(meta?.updatedAtMs) ?? stat.mtimeMs;
    const title =
      (typeof meta?.title === "string" && meta.title.trim()) ||
      (firstPrompt ? firstPrompt.slice(0, 70) : "(untitled session)");

    return {
      tool: "cursor",
      id,
      dir: workspaceDir(file),
      title,
      firstPrompt,
      start,
      end,
      msgCount,
      file,
    };
  },

  resume(s: Session): ResumePlan {
    return {
      argv: ["cursor", s.dir],
      shell: `cursor ${shq(s.dir)}  # then reopen the chat from Cursor history (no per-session CLI resume)`,
    };
  },

  transcript(s: Session): Turn[] {
    return transcriptTurns(s.file);
  },
};

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
