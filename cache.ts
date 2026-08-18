import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOURCES } from "./sources/index.ts";
import type { Session } from "./sources/types.ts";

const CACHE_DIR = join(homedir(), ".cache", "convos");
const CACHE_FILE = join(CACHE_DIR, "index.json");

interface Entry {
  mtimeMs: number;
  size: number;
  sourceKey?: string;
  session: Session;
}
type Cache = Record<string, Entry>; // keyed by transcript file path

function load(): Cache {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(cache: Cache): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// Build (or incrementally refresh) the unified index across all sources.
// Only re-parses transcripts whose mtime or size changed since last run.
export function buildIndex(): Session[] {
  const cache = load();
  const next: Cache = {};
  const bulk: Session[] = []; // sessions from scan()-based sources (not cached)
  let reparsed = 0;

  for (const source of SOURCES) {
    if (!source.available()) continue;

    // BULK/DB-BASED source: one query returns everything, re-run each time so
    // it's always fresh (a stale cache is exactly the bug this avoids).
    if (source.scan) {
      bulk.push(...source.scan());
      continue;
    }

    // FILE-BASED source: cache by mtime/size, only re-parse changed files.
    const sourceKey = source.cacheKey?.();
    for (const file of source.files!()) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue; // file vanished mid-scan
      }
      const prev = cache[file];
      if (
        prev &&
        prev.mtimeMs === st.mtimeMs &&
        prev.size === st.size &&
        prev.sourceKey === sourceKey
      ) {
        next[file] = prev; // unchanged → reuse
        continue;
      }
      const session = source.parse!(file);
      if (!session) continue;
      next[file] = { mtimeMs: st.mtimeMs, size: st.size, sourceKey, session };
      reparsed++;
    }
  }

  save(next);
  const sessions = [...Object.values(next).map((e) => e.session), ...bulk];
  if (process.env.CONVOS_DEBUG) {
    console.error(`[convos] indexed ${sessions.length} sessions (${reparsed} reparsed, ${bulk.length} bulk)`);
  }

  return sessions.sort((a, b) => b.end - a.end); // most recent first
}

// Lookup of a single session by id (used by the fzf preview hook). Rebuilds the
// index (cheap: file cache is reused, bulk sources are a single query) so it
// covers every source, not just the file-cached ones.
export function findById(id: string): Session | undefined {
  return buildIndex().find((s) => s.id === id);
}

export const CACHE_PATH = CACHE_FILE;
