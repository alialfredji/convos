import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Source, ResumePlan } from "./types.ts";

const PROJECTS = join(homedir(), ".claude", "projects");

// Pull plain text out of a Claude message `content`, which may be a string
// or an array of blocks. Returns "" for non-text (e.g. tool_result) content.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // A user turn that is really a tool result, not something the human typed.
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

export const claude: Source = {
  name: "claude",

  available() {
    return existsSync(PROJECTS);
  },

  files() {
    if (!existsSync(PROJECTS)) return [];
    const out: string[] = [];
    for (const proj of readdirSync(PROJECTS)) {
      const dir = join(PROJECTS, proj);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      // Only top-level transcripts. Nested `<id>/subagents/agent-*.jsonl` are
      // subagent sidechains of a parent session, not resumable conversations.
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

      if (!id && o.sessionId) id = o.sessionId;
      if (!cwd && o.cwd) cwd = o.cwd;
      if (o.type === "ai-title" && o.aiTitle) title = o.aiTitle;

      if (o.timestamp) {
        const t = Date.parse(o.timestamp);
        if (!Number.isNaN(t)) {
          if (t < min) min = t;
          if (t > max) max = t;
        }
      }

      if (o.type === "user" || o.type === "assistant") {
        const text = textOf(o.message?.content);
        if (o.type === "user" && !firstPrompt && text && !isMeta(text)) {
          firstPrompt = clean(text).slice(0, 240);
        }
        if (text) msgCount++;
      }
    }

    // Session id falls back to the filename (which IS the uuid).
    if (!id) id = file.split("/").pop()!.replace(/\.jsonl$/, "");

    const st = statSync(file);
    const end = max || st.mtimeMs;
    const start = Number.isFinite(min) ? min : st.mtimeMs;

    if (!title) title = firstPrompt ? firstPrompt.slice(0, 70) : "(untitled session)";

    return {
      tool: "claude",
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
      argv: ["claude", "--resume", s.id],
      shell: `cd ${shq(s.dir)} && claude --resume ${s.id}`,
    };
  },
};

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
