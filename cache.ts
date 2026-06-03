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
  let reparsed = 0;

  for (const source of SOURCES) {
    if (!source.available()) continue;
    for (const file of source.files()) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue; // file vanished mid-scan
      }
      const prev = cache[file];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        next[file] = prev; // unchanged → reuse
        continue;
      }
      const session = source.parse(file);
      if (!session) continue;
      next[file] = { mtimeMs: st.mtimeMs, size: st.size, session };
      reparsed++;
    }
  }

  save(next);
  if (process.env.CONVOS_DEBUG) {
    console.error(`[convos] indexed ${Object.keys(next).length} sessions (${reparsed} reparsed)`);
  }

  return Object.values(next)
    .map((e) => e.session)
    .sort((a, b) => b.end - a.end); // most recent first
}

// Fast lookup of a single session by id (used by the fzf preview hook).
export function findById(id: string): Session | undefined {
  const cache = load();
  for (const e of Object.values(cache)) {
    if (e.session.id === id) return e.session;
  }
  return undefined;
}

export const CACHE_PATH = CACHE_FILE;
