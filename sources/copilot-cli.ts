import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import type { Session, Source, ResumePlan, Turn } from "./types.ts";

// The GitHub Copilot CLI keeps one directory per session under
// ~/.copilot/session-state/<uuid>/. The transcript is events.jsonl (one JSON
// event per line); workspace.yaml / checkpoints / files sit alongside it but we
// only need the event log. The <uuid> directory name is exactly the id that
// `copilot --resume=<id>` expects.
const SESSION_ROOT = join(homedir(), ".copilot", "session-state");

// A user/assistant message `content` is a plain string for the Copilot CLI, but
// guard against an array-of-blocks shape so a format change degrades gracefully.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as any)?.text ?? ""))
      .join(" ");
  }
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

export const copilotCli: Source = {
  name: "copilot-cli",

  available() {
    return existsSync(SESSION_ROOT);
  },

  files() {
    if (!existsSync(SESSION_ROOT)) return [];
    const out: string[] = [];
    // Layout: <root>/<uuid>/events.jsonl — one transcript per session directory.
    for (const sub of readdirSync(SESSION_ROOT)) {
      const events = join(SESSION_ROOT, sub, "events.jsonl");
      if (existsSync(events)) out.push(events);
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

    // The id is the session-state directory name (what `copilot --resume=` takes),
    // not a field inside the file: .../session-state/<uuid>/events.jsonl.
    const id = basename(dirname(file));

    let cwd = "";
    let firstPrompt = "";
    let min = Infinity;
    let max = 0;
    let msgCount = 0;
    let sawStart = false;

    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }

      // session.start carries the working directory under data.context.cwd.
      if (o.type === "session.start") {
        sawStart = true;
        if (!cwd) cwd = o.data?.context?.cwd ?? o.data?.cwd ?? "";
      }

      if (o.timestamp) {
        const t = Date.parse(o.timestamp);
        if (!Number.isNaN(t)) {
          if (t < min) min = t;
          if (t > max) max = t;
        }
      }

      // Conversation turns. user.message / assistant.message are the real
      // human/model turns; tool.* and *.turn_start/_end events are bookkeeping.
      if (o.type === "user.message" || o.type === "assistant.message") {
        const text = textOf(o.data?.content);
        if (o.type === "user.message" && !firstPrompt && text && !isMeta(text)) {
          firstPrompt = clean(text).slice(0, 240);
        }
        if (text) msgCount++;
      }
    }

    // Empty/aborted session (no header and no turns) → skip.
    if (!sawStart && msgCount === 0) return null;

    const st = statSync(file);
    const end = max || st.mtimeMs;
    const start = Number.isFinite(min) ? min : st.mtimeMs;
    const title = firstPrompt ? firstPrompt.slice(0, 70) : "(untitled session)";

    return {
      tool: "copilot-cli",
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
    // `--resume=<id>` resumes a specific session. The value must be attached
    // with `=`; a space-separated value would be parsed as a new prompt instead.
    return {
      argv: ["copilot", `--resume=${s.id}`],
      shell: `cd ${shq(s.dir)} && copilot --resume=${s.id}`,
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
      const role =
        o.type === "user.message" ? "user" : o.type === "assistant.message" ? "assistant" : null;
      if (!role) continue;
      const text = clean(textOf(o.data?.content));
      if (!text || text.startsWith("<")) continue;
      turns.push({ role, text });
    }
    return turns;
  },
};

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
