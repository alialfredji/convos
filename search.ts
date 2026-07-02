import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildIndex } from "./cache.ts";
import { formatToolCall } from "./export.ts";
import { sourceByName } from "./sources/index.ts";
import type { Session, Turn } from "./sources/types.ts";

// A single content-search result. Higher score = better match.
export interface SearchHit {
  session: Session;
  score: number;
  snippet: string;
  matchCount: number;
}

// Default on-disk index location; tests override via CONVOS_SEARCH_DB.
function dbPath(): string {
  return process.env.CONVOS_SEARCH_DB || join(homedir(), ".cache", "convos", "search.db");
}

// The FTS "text" column is the 4th column (0-based index 3) of the turns table.
const TEXT_COL = 3;

// ---------------------------------------------------------------------------
// Internal engine: opens a DB at a given path and exposes index/query. Kept
// free of buildIndex()/sources so tests can drive it with synthetic data.
// ---------------------------------------------------------------------------
export class SearchIndex {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        key TEXT PRIMARY KEY,
        sig TEXT,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        json TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS turns USING fts5(
        session_id UNINDEXED,
        ord UNINDEXED,
        role UNINDEXED,
        text
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // The stable key for a session: a real per-session file, else tool:id (bulk
  // sources share one DB file so the path can't distinguish them).
  private static key(s: Session): string {
    const f = s.file;
    if (f && f !== "(unknown)") {
      try {
        statSync(f); // must be a real, statable file
        return f;
      } catch {
        // fall through to synthetic key
      }
    }
    return `${s.tool}:${s.id}`;
  }

  // A cheap change signature. File-based -> mtime:size; otherwise end:msgCount.
  private static sig(s: Session): string {
    const f = s.file;
    if (f && f !== "(unknown)") {
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        // fall through
      }
    }
    return `${s.end}:${s.msgCount}`;
  }

  // Index an explicit list of session + turns pairs, incrementally. Returns the
  // number of sessions that were (re)indexed. `getTurns` lazily fetches turns so
  // unchanged sessions never pay the extraction cost.
  indexExplicit(items: { session: Session; turns: Turn[] }[]): number {
    const pairs = items.map((it) => ({ session: it.session, getTurns: () => it.turns }));
    return this.indexLazy(pairs);
  }

  indexLazy(
    items: { session: Session; getTurns: () => Turn[] }[],
    opts: { onLargeBuild?: (n: number) => void } = {}
  ): number {
    const getSig = this.db.query<{ sig: string }, [string]>("SELECT sig FROM docs WHERE key = ?");

    // Cheap read-only first pass: compute each session's key + sig (no turn
    // extraction) to learn which ones are stale and must be reindexed. This
    // lets us report an accurate build size and skip work when nothing changed.
    const present = new Set<string>();
    const stale: { session: Session; getTurns: () => Turn[]; key: string; sig: string }[] = [];
    for (const { session, getTurns } of items) {
      const key = SearchIndex.key(session);
      const sig = SearchIndex.sig(session);
      present.add(key);
      const prev = getSig.get(key);
      if (prev && prev.sig === sig) continue; // unchanged
      stale.push({ session, getTurns, key, sig });
    }

    if (stale.length > 20) opts.onLargeBuild?.(stale.length);

    const delTurns = this.db.query("DELETE FROM turns WHERE session_id = ?");
    const upsertDoc = this.db.query(
      "INSERT INTO docs (key, sig, session_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET sig = excluded.sig, session_id = excluded.session_id"
    );
    const upsertSession = this.db.query(
      "INSERT INTO sessions (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json"
    );
    const insTurn = this.db.query(
      "INSERT INTO turns (session_id, ord, role, text) VALUES (?, ?, ?, ?)"
    );
    const delDoc = this.db.query("DELETE FROM docs WHERE key = ?");
    const delSession = this.db.query("DELETE FROM sessions WHERE id = ?");

    const run = this.db.transaction(() => {
      for (const { session, getTurns, key, sig } of stale) {
        delTurns.run(session.id);
        const turns = getTurns();
        let ord = 0;
        for (const turn of turns) {
          const text = turnText(turn);
          if (!text.trim()) continue;
          insTurn.run(session.id, ord++, turn.role, text);
        }
        upsertDoc.run(key, sig, session.id);
        upsertSession.run(session.id, JSON.stringify(session));
      }

      // Prune vanished sessions.
      const allKeys = this.db.query<{ key: string; session_id: string }, []>(
        "SELECT key, session_id FROM docs"
      ).all();
      for (const { key, session_id } of allKeys) {
        if (present.has(key)) continue;
        delTurns.run(session_id);
        delDoc.run(key);
        delSession.run(session_id);
      }
    });

    run();
    return stale.length;
  }

  // Search the index. Never throws: FTS errors yield [] (or recent on blank).
  search(query: string, opts: SearchOpts = {}): SearchHit[] {
    const limit = opts.limit ?? 200;
    const match = sanitizeQuery(query);

    try {
      if (!match) return this.recent(opts, limit);

      // bun:sqlite's query flattener refuses bm25() inside a GROUP BY context,
      // so we wrap the per-turn bm25 in a subquery pinned open with LIMIT -1
      // (blocks flattening) and aggregate to best-score + match-count per session.
      const rows = this.db
        .query<{ session_id: string; b: number; mc: number }, [string, number]>(
          "SELECT session_id, min(b) AS b, count(*) AS mc FROM " +
            "(SELECT session_id, bm25(turns) AS b FROM turns WHERE turns MATCH ? LIMIT -1) " +
            "GROUP BY session_id ORDER BY b LIMIT ?"
        )
        .all(match, limit * 4); // over-fetch; filters may drop some

      const hits: SearchHit[] = [];
      for (const row of rows) {
        const session = this.session(row.session_id);
        if (!session || !passesFilters(session, opts)) continue;
        hits.push({
          session,
          score: bm25ToScore(row.b),
          snippet: this.snippet(row.session_id, match),
          matchCount: row.mc,
        });
        if (hits.length >= limit) break;
      }
      return hits;
    } catch {
      // Malformed FTS expression or other failure: degrade gracefully.
      try {
        return this.recent(opts, limit);
      } catch {
        return [];
      }
    }
  }

  private snippet(sessionId: string, match: string): string {
    try {
      const row = this.db
        .query<{ s: string }, [string, string]>(
          `SELECT snippet(turns, ${TEXT_COL}, '\x1b[1m', '\x1b[0m', '…', 10) AS s
           FROM turns WHERE turns MATCH ? AND session_id = ? ORDER BY bm25(turns) LIMIT 1`
        )
        .get(match, sessionId);
      return row ? oneLine(row.s) : "";
    } catch {
      return "";
    }
  }

  private session(id: string): Session | undefined {
    const row = this.db
      .query<{ json: string }, [string]>("SELECT json FROM sessions WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    try {
      return JSON.parse(row.json) as Session;
    } catch {
      return undefined;
    }
  }

  // Blank-query fallback: most-recent sessions honouring filters.
  private recent(opts: SearchOpts, limit: number): SearchHit[] {
    const rows = this.db.query<{ json: string }, []>("SELECT json FROM sessions").all();
    const sessions: Session[] = [];
    for (const r of rows) {
      try {
        sessions.push(JSON.parse(r.json) as Session);
      } catch {
        // skip
      }
    }
    return sessions
      .filter((s) => passesFilters(s, opts))
      .sort((a, b) => b.end - a.end)
      .slice(0, limit)
      .map((session) => ({ session, score: 0, snippet: "", matchCount: 0 }));
  }
}

interface SearchOpts {
  tool?: string;
  dir?: string;
  since?: number;
  until?: number;
  limit?: number;
}

// Combine a turn's prose with its flattened tool calls into indexable text.
function turnText(turn: Turn): string {
  const tools = (turn.tools ?? []).map(formatToolCall).join(" ");
  return tools ? `${turn.text} ${tools}` : turn.text;
}

// Turn FTS5's bm25 (lower = better, typically negative) into higher = better.
// bm25 returns <= 0 for matches; negate so a stronger match yields a larger
// positive score.
function bm25ToScore(b: number): number {
  return -b;
}

// Make an arbitrary user string safe for an FTS5 MATCH expression. We extract
// word tokens, quote each (so punctuation like ()"*:- can never form syntax),
// and append * to the last token for as-you-type prefix matching.
function sanitizeQuery(query: string): string {
  const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(" ");
}

function passesFilters(s: Session, opts: SearchOpts): boolean {
  if (opts.tool && s.tool !== opts.tool) return false;
  if (opts.dir && !s.dir.toLowerCase().includes(opts.dir.toLowerCase())) return false;
  if (opts.since !== undefined && s.end < opts.since) return false;
  if (opts.until !== undefined && s.start > opts.until) return false;
  return true;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Public API layered over buildIndex() + the real sources at the default path.
// ---------------------------------------------------------------------------
let shared: SearchIndex | undefined;
let sharedPath: string | undefined;

function index(): SearchIndex {
  const path = dbPath();
  if (!shared || sharedPath !== path) {
    shared?.close();
    shared = new SearchIndex(path);
    sharedPath = path;
  }
  return shared;
}

// Refresh the content index from the given sessions (or the full unified index).
export function refreshSearchIndex(sessions?: Session[]): void {
  const list = sessions ?? buildIndex();
  const idx = index();
  idx.indexLazy(
    list.map((session) => ({
      session,
      getTurns: () => sourceByName(session.tool)?.transcript?.(session) ?? [],
    })),
    {
      onLargeBuild: (n) => process.stderr.write(`[convos] indexing ${n} conversations…\n`),
    }
  );
}

// Full-text search across indexed conversation content.
export function searchSessions(query: string, opts: SearchOpts = {}): SearchHit[] {
  return index().search(query, opts);
}
