import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Source, ResumePlan, Turn } from "./types.ts";

const STORAGE = join(homedir(), ".local", "share", "opencode", "storage");
const SESSION = join(STORAGE, "session");
const MESSAGE = join(STORAGE, "message");
const PART = join(STORAGE, "part");

function clean(text: string): string {
  return text.replace(/^[❯>]\s*/, "").replace(/\s+/g, " ").trim();
}

// Best-effort: pull the first user message's text for a session. Message and
// part files are id-prefixed in time order, so the lexically-first message file
// is the earliest turn (a user prompt). Its text lives in part/<msgID>/prt_*.json
// as a block with `type: "text"`. Returns "" if anything is missing — the title
// is the primary display, so this is never allowed to fail the parse.
function firstPromptOf(id: string): string {
  const msgDir = join(MESSAGE, id);
  let msgs: string[];
  try {
    msgs = readdirSync(msgDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return "";
  }
  for (const msg of msgs) {
    const msgId = msg.replace(/\.json$/, "");
    let parts: string[];
    try {
      parts = readdirSync(join(PART, msgId)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const p of parts) {
      try {
        const o = JSON.parse(readFileSync(join(PART, msgId, p), "utf8"));
        if (o?.type === "text" && typeof o.text === "string" && o.text.trim()) {
          return clean(o.text).slice(0, 240);
        }
      } catch {
        continue;
      }
    }
  }
  return "";
}

// Count message files for a session; the message/<id>/ dir holds one per turn.
function msgCountOf(id: string): number {
  try {
    return readdirSync(join(MESSAGE, id)).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export const opencode: Source = {
  name: "opencode",

  available() {
    return existsSync(SESSION);
  },

  files() {
    if (!existsSync(SESSION)) return [];
    const out: string[] = [];
    // Each subdirectory of session/ is one project (plus a literal "global"
    // dir); every ses_*.json inside is one session.
    for (const proj of readdirSync(SESSION)) {
      const dir = join(SESSION, proj);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (f.startsWith("ses_") && f.endsWith(".json")) out.push(join(dir, f));
      }
    }
    return out;
  },

  parse(file: string): Session | null {
    let o: any;
    try {
      o = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }

    const id: string = o.id || file.split("/").pop()!.replace(/\.json$/, "");
    const firstPrompt = firstPromptOf(id);

    const st = statSync(file);
    const start = typeof o.time?.created === "number" ? o.time.created : st.mtimeMs;
    const end = typeof o.time?.updated === "number" ? o.time.updated : st.mtimeMs;

    let title: string = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) title = firstPrompt ? firstPrompt.slice(0, 70) : "(untitled session)";

    return {
      tool: "opencode",
      id,
      dir: o.directory || "(unknown)",
      title,
      firstPrompt,
      start,
      end,
      msgCount: msgCountOf(id),
      file,
    };
  },

  resume(s: Session): ResumePlan {
    // `opencode -s <id>` continues a specific session by id (from `--help`:
    // "-s, --session  session id to continue").
    return {
      argv: ["opencode", "--session", s.id],
      shell: `cd ${shq(s.dir)} && opencode --session ${s.id}`,
    };
  },

  transcript(s: Session): Turn[] {
    // Turns live in message/<id>/<msgID>.json (role) with text in the
    // part/<msgID>/prt_*.json blocks. Both are id-prefixed in time order.
    let msgs: string[];
    try {
      msgs = readdirSync(join(MESSAGE, s.id)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const turns: Turn[] = [];
    for (const msg of msgs) {
      let role: any;
      try {
        role = JSON.parse(readFileSync(join(MESSAGE, s.id, msg), "utf8")).role;
      } catch {
        continue;
      }
      if (role !== "user" && role !== "assistant") continue;
      const msgId = msg.replace(/\.json$/, "");
      let parts: string[];
      try {
        parts = readdirSync(join(PART, msgId)).filter((f) => f.endsWith(".json")).sort();
      } catch {
        continue;
      }
      const text = parts
        .map((p) => {
          try {
            const o = JSON.parse(readFileSync(join(PART, msgId, p), "utf8"));
            return o?.type === "text" && typeof o.text === "string" ? o.text : "";
          } catch {
            return "";
          }
        })
        .join(" ");
      const cleaned = clean(text);
      if (cleaned) turns.push({ role, text: cleaned });
    }
    return turns;
  },
};

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
