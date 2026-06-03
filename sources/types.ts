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

// How to re-enter a session for a given tool.
export interface ResumePlan {
  // Command + args to exec (stdio inherited) to relaunch interactively.
  argv: string[];
  // Shell one-liner the user can copy/paste to do the same by hand.
  shell: string;
}

// A pluggable conversation source. Add a new tool by implementing this.
export interface Source {
  name: string;
  // True when this tool's data exists on the machine.
  available(): boolean;
  // Discover transcript files. Returned paths are passed back to parse().
  files(): string[];
  // Parse one transcript file into a Session (or null to skip).
  parse(file: string): Session | null;
  // Build the resume plan for one of this source's sessions.
  resume(s: Session): ResumePlan;
}
