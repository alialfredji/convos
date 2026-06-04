import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, basename, extname } from "node:path";
import type { Session, Source, ResumePlan, Turn } from "./types.ts";

// VS Code's Copilot Chat history lives per workspace under
//   <userData>/User/workspaceStorage/<hash>/chatSessions/<sessionId>.{json,jsonl}
// where <hash> maps back to a real folder via the sibling workspace.json.
// <userData> is OS-specific; we cover the stable + Insiders builds on each.
function chatRoots(): string[] {
  const home = homedir();
  const apps = ["Code", "Code - Insiders"];
  let bases: string[];
  if (platform() === "darwin") {
    bases = apps.map((a) => join(home, "Library", "Application Support", a));
  } else if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    bases = apps.map((a) => join(appData, a));
  } else {
    bases = apps.map((a) => join(home, ".config", a));
  }
  return bases.map((b) => join(b, "User", "workspaceStorage"));
}

// Map a chatSessions file back to its workspace folder via the sibling
// workspace.json: <hash>/workspace.json -> { folder | workspace: "file://..." }.
// Path shape: <hash>/chatSessions/<id>.jsonl  ->  hashDir = dirname(dirname(file)).
function workspaceDir(file: string): string {
  const hashDir = dirname(dirname(file));
  try {
    const ws = JSON.parse(readFileSync(join(hashDir, "workspace.json"), "utf8"));
    const uri: string | undefined = ws.folder ?? ws.workspace;
    if (!uri) return "(unknown)"; // empty-window chat, no folder
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  } catch {
    return "(unknown)";
  }
}

// Pull plain text out of a chat message or response, which may be a string, an
// IMarkdownString-ish { value }, a request { text } / { parts: [...] }, a
// response array of blocks, or { content: ... }. Recurses through those shapes
// and ignores non-text blocks (tool calls, code-citation refs, etc.) and
// "thinking" parts (the model's reasoning, not its reply).
function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  const o = node as any;
  if (o.kind === "thinking") return "";
  if (o.value !== undefined) return textOf(o.value);
  if (o.text !== undefined) return textOf(o.text);
  if (o.content !== undefined) return textOf(o.content);
  if (Array.isArray(o.parts)) return o.parts.map(textOf).join("");
  return "";
}

// True for synthetic/meta messages we don't want to surface as "the first thing
// the user said" (system reminders, harness-injected wrappers, etc.).
function isMeta(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") || t.startsWith("Caveat:");
}

function clean(text: string): string {
  return text.replace(/^[❯>]\s*/, "").replace(/\s+/g, " ").trim();
}

// creationDate / lastMessageDate are epoch ms, but tolerate an ISO string too.
function toEpoch(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// Set obj at the path (array of string keys / numeric indices) to value,
// creating intermediate containers as needed. Used to replay the newer .jsonl
// delta log onto its line-0 base object.
function setPath(obj: any, path: (string | number)[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (cur[k] == null || typeof cur[k] !== "object") {
      cur[k] = typeof path[i + 1] === "number" ? [] : {};
    }
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

// Reconstruct the full chat-session object from either on-disk format:
//   .json  — the whole file is the session object.
//   .jsonl — line 0 {kind:0, v} is the base object; each later {kind, k, v} is
//            a patch that sets path k to v. Replaying them yields the same shape.
function loadSession(file: string): any | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (extname(file) === ".json") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  let base: any = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (base == null) {
      base = o?.v ?? {}; // line 0: the full base object
      continue;
    }
    if (Array.isArray(o?.k)) setPath(base, o.k, o.v); // later lines: patches
  }
  return base;
}

export const copilotVscode: Source = {
  name: "copilot-vscode",

  available() {
    return chatRoots().some((r) => existsSync(r));
  },

  files() {
    const out: string[] = [];
    for (const root of chatRoots()) {
      if (!existsSync(root)) continue;
      for (const hash of readdirSync(root)) {
        const chatDir = join(root, hash, "chatSessions");
        let entries: string[];
        try {
          entries = readdirSync(chatDir);
        } catch {
          continue; // this workspace has no chat history
        }
        // One file per session. If both <id>.json and <id>.jsonl exist for the
        // same id, prefer the newer .jsonl delta log.
        const byId = new Map<string, string>();
        for (const f of entries) {
          const ext = extname(f);
          if (ext !== ".json" && ext !== ".jsonl") continue;
          const id = basename(f, ext);
          if (ext === ".jsonl" || !byId.has(id)) byId.set(id, join(chatDir, f));
        }
        out.push(...byId.values());
      }
    }
    return out;
  },

  parse(file: string): Session | null {
    const s = loadSession(file);
    if (!s) return null;

    const id = s.sessionId || basename(file, extname(file));
    const reqs: any[] = Array.isArray(s.requests) ? s.requests : [];

    let firstPrompt = "";
    let msgCount = 0;
    for (const r of reqs) {
      const userText = textOf(r?.message);
      const respText = textOf(r?.response);
      if (!firstPrompt && userText && !isMeta(userText)) {
        firstPrompt = clean(userText).slice(0, 240);
      }
      if (userText) msgCount++; // user turn
      if (respText) msgCount++; // assistant turn
    }

    // Empty/abandoned chat (no exchanges) → skip; matches the CLI source.
    if (msgCount === 0) return null;

    const st = statSync(file);
    const start = toEpoch(s.creationDate) ?? st.mtimeMs;
    const end = toEpoch(s.lastMessageDate) ?? st.mtimeMs;
    const title =
      (typeof s.customTitle === "string" && s.customTitle.trim()) ||
      (firstPrompt ? firstPrompt.slice(0, 70) : "(untitled session)");

    return {
      tool: "copilot-vscode",
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
    // VS Code chats are GUI-bound: there is no CLI flag to reopen one chat
    // session by id. Best effort is to open the workspace folder; the chat is
    // then reachable from the Chat view's history. Use code-insiders when the
    // transcript came from the Insiders build.
    const bin = s.file.includes("Code - Insiders") ? "code-insiders" : "code";
    return {
      argv: [bin, s.dir],
      shell: `${bin} ${shq(s.dir)}  # then reopen the chat from the Chat view history (no per-session CLI resume)`,
    };
  },

  transcript(s: Session): Turn[] {
    const session = loadSession(s.file);
    const reqs: any[] = Array.isArray(session?.requests) ? session.requests : [];
    const turns: Turn[] = [];
    for (const r of reqs) {
      const u = clean(textOf(r?.message));
      if (u && !u.startsWith("<")) turns.push({ role: "user", text: u });
      const a = clean(textOf(r?.response));
      if (a) turns.push({ role: "assistant", text: a });
    }
    return turns;
  },
};

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
