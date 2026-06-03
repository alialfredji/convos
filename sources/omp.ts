import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Source, ResumePlan, Turn } from "./types.ts";

const SESSIONS = join(homedir(), ".pi", "agent", "sessions");

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
    return existsSync(SESSIONS);
  },

  files() {
    if (!existsSync(SESSIONS)) return [];
    const out: string[] = [];
    // Layout: <sessions>/<encoded-cwd-dir>/<iso>_<uuid>.jsonl. One file per
    // session. Walk every subdir; some may be empty — skip gracefully.
    for (const sub of readdirSync(SESSIONS)) {
      const dir = join(SESSIONS, sub);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (f.endsWith(".jsonl")) out.push(join(dir, f));
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

      // Line 0 is the session header: { type:"session", id, timestamp, cwd }.
      // omp has no title field, so we derive it from the first real prompt.
      if (o.type === "session") {
        if (o.id) id = o.id;
        if (o.cwd) cwd = o.cwd;
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
