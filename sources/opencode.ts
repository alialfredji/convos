import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Source, ResumePlan, Turn } from "./types.ts";

// OpenCode migrated from per-session JSON files (storage/session/*.json) to a
// single SQLite database. The DB is the authoritative, current store — the old
// JSON files are stale, so we read only the DB here.
const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

function open(): Database {
  return new Database(DB_PATH, { readonly: true });
}

function clean(text: string): string {
  return text.replace(/^[❯>]\s*/, "").replace(/\s+/g, " ").trim();
}

export const opencode: Source = {
  name: "opencode",

  available() {
    return existsSync(DB_PATH);
  },

  scan(): Session[] {
    let db: Database;
    try {
      db = open();
    } catch {
      return [];
    }
    try {
      // parent_id IS NULL → top-level conversations only (children are subagent
      // sessions, excluded like subagent sidechains in the other sources).
      const rows = db
        .query(
          "SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL"
        )
        .all() as Array<{
        id: string;
        directory: string;
        title: string;
        time_created: number;
        time_updated: number;
      }>;

      // One grouped query for message counts, rather than 500+ subqueries.
      const counts = new Map<string, number>();
      for (const r of db
        .query("SELECT session_id, count(*) c FROM message GROUP BY session_id")
        .all() as Array<{ session_id: string; c: number }>) {
        counts.set(r.session_id, r.c);
      }

      return rows.map((r) => ({
        tool: "opencode",
        id: r.id,
        dir: r.directory || "(unknown)",
        title: (r.title || "").trim() || "(untitled session)",
        firstPrompt: "", // title is always present; preview reads transcript()
        start: r.time_created,
        end: r.time_updated,
        msgCount: counts.get(r.id) ?? 0,
        file: DB_PATH,
      }));
    } finally {
      db.close();
    }
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
    let db: Database;
    try {
      db = open();
    } catch {
      return [];
    }
    try {
      const msgs = db
        .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created")
        .all(s.id) as Array<{ id: string; data: string }>;
      const partStmt = db.query(
        "SELECT data FROM part WHERE message_id = ? ORDER BY time_created"
      );

      const turns: Turn[] = [];
      for (const m of msgs) {
        let role: any;
        try {
          role = JSON.parse(m.data).role;
        } catch {
          continue;
        }
        if (role !== "user" && role !== "assistant") continue;

        const parts = partStmt.all(m.id) as Array<{ data: string }>;
        const text = parts
          .map((p) => {
            try {
              const o = JSON.parse(p.data);
              if (o?.type !== "text" || typeof o.text !== "string") return "";
              // Skip harness-injected wrappers (system reminders, etc.).
              return o.text.trimStart().startsWith("<") ? "" : o.text;
            } catch {
              return "";
            }
          })
          .join(" ");
        const cleaned = clean(text);
        if (cleaned) turns.push({ role, text: cleaned });
      }
      return turns;
    } finally {
      db.close();
    }
  },
};

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
