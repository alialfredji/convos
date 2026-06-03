// A single normalized conversation, shared across every AI tool.
export interface Session {
  tool: string; // e.g. "claude"
  id: string; // session id used to resume
  dir: string; // working directory the conversation happened in
  title: string; // human-readable title (ai-generated when available)
  firstPrompt: string; // first real user message
  start: number; // epoch ms of first activity
  end: number; // epoch ms of last activity
  msgCount: number; // user + assistant turns
  file: string; // path to the transcript on disk
}

// One conversation turn, used to render the picker preview.
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

// How to re-enter a session for a given tool.
export interface ResumePlan {
  // Command + args to exec (stdio inherited) to relaunch interactively.
  argv: string[];
  // Shell one-liner the user can copy/paste to do the same by hand.
  shell: string;
}

// A pluggable conversation source. Add a new tool by implementing this.
//
// A source is either FILE-BASED (implements files() + parse(), one transcript
// file per session — the index caches these by mtime/size) or BULK/DB-BASED
// (implements scan(), returning every session in one shot — re-scanned each run,
// which suits a database query). Implement one mode or the other.
export interface Source {
  name: string;
  // True when this tool's data exists on the machine.
  available(): boolean;
  // FILE-BASED: discover transcript files; paths are passed back to parse().
  files?(): string[];
  // FILE-BASED: parse one transcript file into a Session (or null to skip).
  parse?(file: string): Session | null;
  // BULK/DB-BASED: return every session directly (no per-file caching).
  scan?(): Session[];
  // Build the resume plan for one of this source's sessions.
  resume(s: Session): ResumePlan;
  // Read the conversation turns for the picker preview (optional; the preview
  // falls back to the session's firstPrompt when a source doesn't implement it).
  transcript?(s: Session): Turn[];
}
