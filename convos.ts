#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { buildIndex, findById } from "./cache.ts";
import { sourceByName } from "./sources/index.ts";
import type { Session } from "./sources/types.ts";

const HOME = homedir();
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function shortDir(dir: string): string {
  return dir.startsWith(HOME) ? "~" + dir.slice(HOME.length) : dir;
}

// "today 14:32" / "yest  18:40" / "Mon  09:10" / "2026-05-22" depending on age.
function relDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(d)) / 86_400_000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diffDays === 0) return `today ${hm}`;
  if (diffDays === 1) return `yest  ${hm}`;
  if (diffDays < 7) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]}   ${hm}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// ── filtering ────────────────────────────────────────────────────────────────
function applyFilters(sessions: Session[], args: Record<string, string | boolean>): Session[] {
  let out = sessions;
  if (args.today) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    out = out.filter((s) => s.end >= start.getTime());
  }
  if (typeof args.dir === "string") {
    const needle = args.dir.toLowerCase();
    out = out.filter((s) => s.dir.toLowerCase().includes(needle));
  }
  if (typeof args.tool === "string") {
    out = out.filter((s) => s.tool === args.tool);
  }
  return out;
}

// ── rendering ──────────────────────────────────────────────────────────────--
// Tab-delimited: <id>\t<display>. fzf shows + searches only the display field.
function row(s: Session): string {
  const display = `${C.dim(pad(relDate(s.end), 11))}  ${C.cyan(pad(s.tool, 8))}  ${C.green(
    pad(shortDir(s.dir), 34)
  )}  ${C.bold(s.title)}`;
  return `${s.id}\t${display}`;
}

function plainList(sessions: Session[]): void {
  if (sessions.length === 0) {
    console.log("No conversations match.");
    return;
  }
  for (const s of sessions) {
    console.log(
      `${pad(relDate(s.end), 11)}  ${pad(s.tool, 8)}  ${pad(shortDir(s.dir), 34)}  ${s.title}`
    );
  }
}

// ── preview (invoked by fzf per highlighted row) ─────────────────────────────-
function preview(id: string): void {
  const s = findById(id);
  if (!s) {
    console.log("(no session)");
    return;
  }
  console.log(C.bold(s.title));
  console.log(C.dim(`${s.tool}  ·  ${shortDir(s.dir)}`));
  console.log(
    C.dim(
      `${new Date(s.start).toLocaleString()}  →  ${new Date(
        s.end
      ).toLocaleString()}  ·  ${s.msgCount} msgs`
    )
  );
  console.log(C.dim("─".repeat(50)));

  // Each source knows how to read its own transcript format.
  const src = sourceByName(s.tool);
  const raw = src?.transcript?.(s) ?? [];
  const turns = raw
    .filter((t) => t.text)
    .map((t) => {
      const tag = t.role === "user" ? C.cyan("▸ you") : C.yellow("◂ ai ");
      return `${tag}  ${t.text.slice(0, 280)}`;
    });
  // Fall back to the first prompt when a source has no transcript reader.
  if (turns.length === 0 && s.firstPrompt) {
    console.log(`${C.cyan("▸ you")}  ${s.firstPrompt}`);
    return;
  }
  // Show the opening exchange and the most recent turns.
  const head = turns.slice(0, 4);
  const tail = turns.slice(-6);
  const shown = turns.length <= 10 ? turns : [...head, C.dim(`   … ${turns.length - 10} turns …`), ...tail];
  console.log(shown.join("\n\n"));
}

// ── actions ──────────────────────────────────────────────────────────────────
function launch(s: Session): never {
  const src = sourceByName(s.tool)!;
  const { argv } = src.resume(s);
  console.error(C.dim(`↻ resuming in ${shortDir(s.dir)} …`));
  const r = spawnSync(argv[0], argv.slice(1), { cwd: s.dir, stdio: "inherit" });
  process.exit(r.status ?? 0);
}

function copyCmd(s: Session): void {
  const src = sourceByName(s.tool)!;
  const { shell } = src.resume(s);
  // Try to put it on the clipboard; always print it too.
  spawnSync("pbcopy", { input: shell });
  console.log(shell);
  console.error(C.dim("(copied to clipboard)"));
}

// ── picker ─────────────────────────────────────────────────────────────────--
function pick(sessions: Session[]): void {
  if (sessions.length === 0) {
    console.error("No conversations found.");
    process.exit(0);
  }
  const input = sessions.map(row).join("\n");
  const r = spawnSync(
    "fzf",
    [
      "--ansi",
      "--delimiter=\t",
      "--with-nth=2",
      "--no-sort",
      "--height=90%",
      "--layout=reverse",
      "--border",
      "--prompt=convos ▸ ",
      "--header=enter: resume  ·  ctrl-y: copy command  ·  ctrl-/: toggle preview",
      "--preview=convos _preview {1}",
      "--preview-window=down:55%:wrap",
      "--bind=ctrl-/:toggle-preview",
      "--expect=ctrl-y,enter",
    ],
    { input, stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" }
  );

  // Esc / Ctrl-C → fzf exits 130, nothing selected.
  if (!r.stdout) process.exit(0);
  const lines = r.stdout.split("\n");
  const key = lines[0];
  const selected = lines[1];
  if (!selected) process.exit(0);
  const id = selected.split("\t")[0];
  const s = findById(id);
  if (!s) {
    console.error("Session not found in index.");
    process.exit(1);
  }
  if (key === "ctrl-y") copyCmd(s);
  else launch(s);
}

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  const cmd = positional[0] && !positional[0].startsWith("-") ? positional.shift()! : "";
  return { cmd, positional, flags };
}

const HELP = `convos — search & resume your AI coding conversations across tools

USAGE
  convos                 open the interactive picker (default)
  convos list            print a plain table (scriptable)
  convos --today         only today's conversations
  convos --dir <substr>  only conversations from matching directories
  convos --tool <name>   only one tool (e.g. claude)
  convos --help          this help

PICKER KEYS
  type           fuzzy-search title / directory / tool / date
  enter          cd into the directory and resume the conversation
  ctrl-y         copy the resume command to the clipboard (don't launch)
  ctrl-/         toggle the transcript preview

Indexes: Claude Code, OpenCode, oh-my-pi (omp), and GitHub Copilot (CLI + VS Code).
More tools are pluggable in convos/sources/.`;

// ── main ───────────────────────────────────────────────────────────────────--
const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

if (cmd === "_preview") {
  preview(positional[0] ?? "");
  process.exit(0);
}
if (flags.help || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}

const sessions = applyFilters(buildIndex(), flags);

if (cmd === "list") plainList(sessions);
else pick(sessions);
