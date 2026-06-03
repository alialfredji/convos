import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Source, ResumePlan, Turn } from "./types.ts";

// omp stores sessions under <agentDir>/sessions. The agent dir moved from
// ~/.pi to ~/.omp (the current location); ~/.pi is kept as a legacy fallback so
// older sessions still appear. Newer roots win on dedup (by session uuid).
const ROOTS = [
  join(homedir(), ".omp", "agent", "sessions"),
  join(homedir(), ".pi", "agent", "sessions"),
];

// Session files are named "<iso-timestamp>_<uuid>.jsonl"; the uuid is the id.
function sessionUuid(filename: string): string {
  return filename.replace(/\.jsonl$/, "").split("_").pop() ?? filename;
}

// Pull plain text out of an omp message `content`, which is an array of blocks
// (text / thinking / toolCall). Returns "" for non-text (e.g. tool_result)
// content. Mirrors claude.ts so titles/prompts read the same way.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // A turn that is really a tool result, not something the human typed.
    if (content.some((b) => b && typeof b === "object" && (b as any).type === "tool_result")) {
      return "";
    }
    return content
      .map((b) => (typeof b === "string" ? b : (b as any)?.type === "text" ? (b as any).text : ""))
      .join(" ");
  }
  return "";
}

// True for synthetic/meta messages we don't want to surface as "the first thing
// the user said" (slash-command wrappers, system reminders, etc.).
function isMeta(text: string): boolean {
  const t = text.trimStart();
  // Real prompts don't begin with an XML-ish wrapper tag (command output,
  // system reminders, local-command caveats) — those are harness-injected.
  return t.startsWith("<") || t.startsWith("Caveat:");
}

function clean(text: string): string {
  return text.replace(/^[❯>]\s*/, "").replace(/\s+/g, " ").trim();
}

export const omp: Source = {
  name: "omp",

  available() {
    return ROOTS.some((r) => existsSync(r));
  },

  files() {
    const out: string[] = [];
    const seen = new Set<string>(); // dedup the same session across roots
    // Layout: <root>/<encoded-cwd-dir>/<iso>_<uuid>.jsonl. One file per session.
    // Nested <iso>_<uuid>/*.jsonl are subagent sidechains and are skipped (we
    // only read the top-level .jsonl entries in each cwd dir).
    for (const root of ROOTS) {
      if (!existsSync(root)) continue;
      for (const sub of readdirSync(root)) {
        const dir = join(root, sub);
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const f of entries) {
          if (!f.endsWith(".jsonl")) continue;
          const uuid = sessionUuid(f);
          if (seen.has(uuid)) continue;
          seen.add(uuid);
          out.push(join(dir, f));
        }
      }
    }
    return out;
  },

  parse(file: string): Session | null {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }

    let cwd = "";
    let title = "";
    let firstPrompt = "";
    let id = "";
    let min = Infinity;
    let max = 0;
    let msgCount = 0;

    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }

      // Line 0 is the session header: { type:"session", id, timestamp, cwd,
      // title? }. Newer sessions carry an auto title; older ones don't, so we
      // fall back to the first real prompt below.
      if (o.type === "session") {
        if (o.id) id = o.id;
        if (o.cwd) cwd = o.cwd;
        if (typeof o.title === "string" && o.title.trim()) title = o.title.trim();
      }

      if (o.timestamp) {
        const t = Date.parse(o.timestamp);
        if (!Number.isNaN(t)) {
          if (t < min) min = t;
          if (t > max) max = t;
        }
      }

      // Conversation turns. Roles seen: user / assistant / toolResult /
      // bashExecution — only the first two are real human/model turns.
      if (o.type === "message" && (o.message?.role === "user" || o.message?.role === "assistant")) {
        const text = textOf(o.message?.content);
        if (o.message.role === "user" && !firstPrompt && text && !isMeta(text)) {
          firstPrompt = clean(text).slice(0, 240);
        }
        if (text) msgCount++;
      }
    }

    // Session id falls back to the filename's uuid (the part after the `_`).
    if (!id) {
      const base = file.split("/").pop()!.replace(/\.jsonl$/, "");
      const us = base.indexOf("_");
      id = us >= 0 ? base.slice(us + 1) : base;
    }

    const st = statSync(file);
    const end = max || st.mtimeMs;
    const start = Number.isFinite(min) ? min : st.mtimeMs;

    if (!title) title = firstPrompt ? firstPrompt.slice(0, 70) : "(untitled session)";

    return {
      tool: "omp",
      id,
      dir: cwd || "(unknown)",
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
      argv: ["omp", "--resume", s.id],
      shell: `cd ${shq(s.dir)} && omp --resume ${s.id}`,
    };
  },

  transcript(s: Session): Turn[] {
    let raw: string;
    try {
      raw = readFileSync(s.file, "utf8");
    } catch {
      return [];
    }
    const turns: Turn[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const role = o.message?.role;
      if (o.type !== "message" || (role !== "user" && role !== "assistant")) continue;
      const text = clean(textOf(o.message?.content));
      if (!text || text.startsWith("<")) continue;
      turns.push({ role, text });
    }
    return turns;
  },
};

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
