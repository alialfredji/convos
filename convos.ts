#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import pkg from "./package.json";
import { buildIndex, findById } from "./cache.ts";
import {
  compactCatalogEntry,
  exportCompactJson,
  parseCompactOptions,
  sessionDigest,
} from "./compact.ts";
import { formatTurnLines, sessionExport, sessionSummary } from "./export.ts";
import { sourceByName } from "./sources/index.ts";
import type { Session } from "./sources/types.ts";
// Type-only import: erased at runtime, so a missing ./search.ts never breaks
// list/_rows. The actual implementation is loaded lazily via `await import` in
// the _search handler (see below), which is the only path that needs it.
import type { SearchHit } from "./search.ts";
import { parseTimeArg } from "./time.ts";

const HOME = homedir();

// How to re-invoke ourselves for fzf's --preview and the _search/_rows reloads.
// Installed → "convos" is on PATH. From source (`bun convos.ts`) → run this same
// file through bun so preview/reload subcommands resolve correctly.
const SELF =
  process.argv[1] && process.argv[1].endsWith("convos.ts")
    ? `bun ${resolve(process.argv[1])}`
    : "convos";
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
  if (args.week) {
    out = out.filter((s) => s.end >= Date.now() - 7 * 86_400_000);
  }
  if (typeof args.since === "string") {
    const since = parseTimeArg(args.since);
    out = out.filter((s) => s.end >= since);
  }
  if (typeof args.until === "string") {
    const until = parseTimeArg(args.until);
    out = out.filter((s) => s.start <= until);
  }
  if (typeof args.dir === "string") {
    const needle = args.dir.toLowerCase();
    out = out.filter((s) => s.dir.toLowerCase().includes(needle));
  }
  if (typeof args.tool === "string") {
    out = out.filter((s) => s.tool === args.tool);
  }
  if (typeof args.limit === "string") {
    const limit = Number(args.limit);
    if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
  }
  return out;
}

// ── rendering ──────────────────────────────────────────────────────────────--
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

// Shared metadata prefix (date · tool · dir · title) — the clean visible columns.
// Reused by row() and searchRow() so metadata renders identically everywhere.
function metaPrefix(s: Session): string {
  return `${C.dim(pad(relDate(s.end), 11))}  ${C.cyan(pad(s.tool, 8))}  ${C.green(
    pad(shortDir(s.dir), 34)
  )}  ${C.bold(s.title)}`;
}

// A short, whitespace-collapsed first-prompt snippet — appended dim so fzf can
// match on it without cluttering the layout. Skipped when it just echoes the
// title (one is a prefix of the other) to avoid duplicate noise.
function promptSnippet(s: Session): string {
  const p = collapseWs(s.firstPrompt);
  if (!p) return "";
  const title = collapseWs(s.title).toLowerCase();
  const pl = p.toLowerCase();
  if (title && (title.startsWith(pl) || pl.startsWith(title))) return "";
  return truncate(p, 64);
}

// Compact, very dim date token so month/weekday queries match, e.g.
// "2026-06 jun mon". Placed last so it never disturbs the visible columns.
function dateToken(ms: number): string {
  const d = new Date(ms);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][
    d.getMonth()
  ];
  const wd = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()];
  return `${ym} ${mon} ${wd}`;
}

// Tab-delimited: <id>\t<display>. fzf shows + searches only the display field.
// display = clean columns + (dim) prompt snippet + (dim) date token, so typing
// fuzzy-matches title/dir/tool/date *and* the first prompt and month/weekday.
function row(s: Session): string {
  let display = metaPrefix(s);
  const snip = promptSnippet(s);
  if (snip) display += C.dim(`  ·  ${snip}`);
  display += C.dim(`  ${dateToken(s.end)}`);
  return `${s.id}\t${display}`;
}

// Row for content-search results: same metadata prefix + the dim in-conversation
// snippet returned by the FTS index.
function searchRow(hit: SearchHit): string {
  let display = metaPrefix(hit.session);
  const snip = collapseWs(hit.snippet);
  if (snip) display += C.dim(`  ·  ${snip}`);
  return `${hit.session.id}\t${display}`;
}

function outputFormat(flags: Record<string, string | boolean>): string {
  if (typeof flags.format === "string") return flags.format;
  if (flags.compact && flags.transcript) return "digest";
  if (flags.compact) return "compact";
  return "json";
}

function plainList(sessions: Session[], flags: Record<string, string | boolean>): void {
  if (sessions.length === 0) {
    console.log("No conversations match.");
    return;
  }
  const compact = parseCompactOptions(flags);
  if (flags.compact) {
    console.log(JSON.stringify(sessions.map((s) => compactCatalogEntry(s, compact))));
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify({ count: sessions.length, sessions: sessions.map(sessionSummary) }, null, 2));
    return;
  }
  for (const s of sessions) {
    const idCol = flags.ids ? `${C.dim(s.id)}  ` : "";
    console.log(
      `${idCol}${pad(relDate(s.end), 11)}  ${pad(s.tool, 8)}  ${pad(shortDir(s.dir), 34)}  ${s.title}`
    );
  }
}

function showSession(s: Session, flags: Record<string, string | boolean>): void {
  const withTranscript = Boolean(flags.transcript);
  const compact = parseCompactOptions(flags);
  const format = outputFormat(flags);

  if (format === "digest") {
    console.log(sessionDigest(s, compact));
    return;
  }
  if (format === "compact" || (flags.compact && flags.json)) {
    if (withTranscript) {
      console.log(exportCompactJson([s], compact, true));
    } else {
      console.log(JSON.stringify(compactCatalogEntry(s, compact)));
    }
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify(sessionExport(s, { transcript: withTranscript }), null, 2));
    return;
  }

  console.log(C.bold(s.title));
  console.log(`${C.dim("id")}       ${s.id}`);
  console.log(`${C.dim("tool")}     ${s.tool}`);
  console.log(`${C.dim("dir")}      ${s.dir}`);
  console.log(`${C.dim("file")}     ${s.file}`);
  console.log(
    `${C.dim("when")}     ${new Date(s.start).toLocaleString()} → ${new Date(s.end).toLocaleString()}`
  );
  console.log(`${C.dim("msgs")}     ${s.msgCount}`);
  if (s.firstPrompt) console.log(`${C.dim("prompt")}   ${s.firstPrompt}`);

  const src = sourceByName(s.tool);
  const { shell } = src ? src.resume(s) : { shell: "" };
  if (shell) console.log(`${C.dim("resume")}   ${shell}`);

  if (!withTranscript) {
    console.log(C.dim("\nAdd --transcript for the full conversation (or --json --transcript for agents)."));
    return;
  }

  const turns = src?.transcript?.(s) ?? [];
  console.log(C.dim("─".repeat(50)));
  for (const t of turns) {
    const tag = t.role === "user" ? C.cyan("▸ you") : C.yellow("◂ ai ");
    console.log(`${tag}\n${formatTurnLines(t).join("\n")}\n`);
  }
}

function exportSessions(sessions: Session[], flags: Record<string, string | boolean>): void {
  const withTranscript = Boolean(flags.transcript);
  const compact = parseCompactOptions(flags);
  const format = outputFormat(flags);

  if (format === "digest") {
    const blocks = sessions.map((s) => sessionDigest(s, compact));
    console.log(blocks.join("\n\n---\n\n"));
    return;
  }
  if (format === "compact") {
    console.log(exportCompactJson(sessions, compact, withTranscript));
    return;
  }
  if (format === "jsonl") {
    for (const s of sessions) {
      console.log(JSON.stringify(sessionExport(s, { transcript: withTranscript })));
    }
    return;
  }
  if (format !== "json") {
    console.error(`Unknown format "${format}" — use json, jsonl, compact, or digest.`);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      { count: sessions.length, sessions: sessions.map((s) => sessionExport(s, { transcript: withTranscript })) },
      null,
      2
    )
  );
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
    .filter((t) => t.text || (t.tools?.length ?? 0) > 0)
    .map((t) => {
      const tag = t.role === "user" ? C.cyan("▸ you") : C.yellow("◂ ai ");
      const body = formatTurnLines(t, { truncate: 280 }).join("\n   ");
      return `${tag}  ${body}`;
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
  const cwd = s.dir && s.dir !== "(unknown)" ? s.dir : process.cwd();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
  if (r.error) {
    console.error(`Failed to run ${argv[0]}: ${r.error.message}`);
    if (argv[0].endsWith("/cursor") || argv[0] === "cursor") {
      console.error(
        C.dim(
          "Tip: install the shell command in Cursor → Command Palette → \"Shell Command: Install 'cursor' command in PATH\""
        )
      );
    }
    process.exit(1);
  }
  process.exit(r.status ?? (r.signal ? 128 : 0));
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
// Single-quote a value for safe embedding in an fzf reload/become command line.
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Reconstruct the currently-active filter scope as CLI flags, so the picker's
// _search / _rows reloads stay within the same slice of sessions. today/week are
// folded into --since since searchSessions() only understands since/until.
function activeFilterArgs(flags: Record<string, string | boolean>): string[] {
  const out: string[] = [];
  if (typeof flags.tool === "string") out.push("--tool", flags.tool);
  if (typeof flags.dir === "string") out.push("--dir", flags.dir);
  let since = typeof flags.since === "string" ? flags.since : undefined;
  if (!since && flags.today) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    since = new Date(d.getTime()).toISOString();
  }
  if (!since && flags.week) since = "7d";
  if (since) out.push("--since", since);
  if (typeof flags.until === "string") out.push("--until", flags.until);
  if (typeof flags.limit === "string") out.push("--limit", flags.limit);
  return out;
}

function pick(sessions: Session[], flags: Record<string, string | boolean>): void {
  if (sessions.length === 0) {
    console.error("No conversations found.");
    process.exit(0);
  }
  const input = sessions.map(row).join("\n");

  // Filter flags shared by both reload commands, shell-quoted.
  const filters = activeFilterArgs(flags).map(shq).join(" ");
  const tail = filters ? ` ${filters}` : "";
  // {q} is expanded (and escaped) by fzf into the current query. Entering content
  // mode refreshes the index once (searchReloadInit); per-keystroke reloads pass
  // --no-refresh so typing is query-only (~0.05s) instead of re-scanning files.
  const searchReloadInit = `${SELF} _search {q}${tail}`;
  const searchReloadType = `${SELF} _search {q} --no-refresh${tail}`;
  const rowsReload = `${SELF} _rows${tail}`;

  const r = spawnSync(
    "fzf",
    [
      "--ansi",
      "--delimiter=\t",
      "--with-nth=2",
      // No --no-sort: with an empty query fzf keeps input (recency) order, but
      // once you type it ranks by match quality so the best hit floats to the
      // top. Content mode disables search, so its bm25 order is preserved anyway.
      "--height=90%",
      "--layout=reverse",
      "--border",
      "--prompt=convos ▸ ",
      "--header=enter: resume  ·  ctrl-y: copy  ·  ctrl-f: search inside  ·  ctrl-/: preview",
      `--preview=${SELF} _preview {1}`,
      "--preview-window=down:55%:wrap",
      "--bind=ctrl-/:toggle-preview",
      // The `change` handler drives content mode; define it, then disable it at
      // startup so the default experience stays native fzf fuzzy over the rows.
      `--bind=change:reload(${searchReloadType})`,
      "--bind=start:unbind(change)",
      // ctrl-f → content mode: stop native filtering, re-query per keystroke, and
      // kick off an initial content search (this one refreshes the index).
      `--bind=ctrl-f:disable-search+change-prompt(convos 🔎 ▸ )+rebind(change)+reload(${searchReloadInit})`,
      // ctrl-g → back to metadata mode: restore native fuzzy over the rows.
      `--bind=ctrl-g:enable-search+change-prompt(convos ▸ )+unbind(change)+reload(${rowsReload})`,
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
  convos                      open the interactive picker (default)
  convos list                 print a plain table (scriptable)
  convos show <id>            print one session (metadata, optional transcript)
  convos export               dump many sessions as JSON (for agent review)
  convos resume <id>          resume one session by id (for testing)
  convos --version            print the installed convos version

FILTERS  (list, export, and the picker)
  --today                     only today's conversations
  --week                      conversations from the last 7 days
  --since <time>              e.g. 7d, 24h, 30m, or 2026-06-21
  --until <time>              upper bound (same formats as --since)
  --dir <substr>              only conversations from matching directories
  --tool <name>               only one tool (e.g. claude, cursor)
  --limit <n>                 cap results (most recent first)

OUTPUT  (for scripts and AI agents)
  convos list --json          session catalog with ids and timestamps
  convos list --compact       minimal catalog JSON (low context)
  convos list --ids           include session id in the plain table
  convos show <id> --json     one session as JSON
  convos show <id> --transcript
                              include full conversation turns
  convos export --week --json --transcript
                              batch export for retrospective review

LOW-CONTEXT  (prefer these for agent review)
  convos list --week --compact
                              tiny catalog: id, tool, dir, title, msgs, prompt
  convos show <id> --format digest --transcript
                              markdown timeline (~5-10x smaller than JSON)
  convos export --week --format digest --transcript
                              batch markdown digests
  convos export --week --format compact --transcript
                              compact JSON with collapsed tool turns
  --tools-only                skip assistant prose; keep user + tool calls
  --max-chars 200             truncate text per turn (default 280 with --compact)
  --collapse-tools            merge consecutive tool-only turns (on with --compact)

AGENT WORKFLOW  (low context)
  1. convos list --week --compact
  2. convos show <id> --format digest --transcript
  3. convos show <id> --json --transcript   only if you need full detail
  — batch: convos export --week --format digest --transcript

AGENT WORKFLOW  (full detail)
  1. convos list --week --json
  2. convos show <id> --json --transcript
  — or one shot: convos export --week --json --transcript

PICKER KEYS
  type           fuzzy-search title / directory / tool / date / first prompt / month
  ctrl-f         search INSIDE conversations (full-text over the transcript)
  ctrl-g         return to metadata search
  enter          cd into the directory and resume the conversation
  ctrl-y         copy the resume command to the clipboard (don't launch)
  ctrl-/         toggle the transcript preview

Indexes: Claude Code, OpenCode, oh-my-pi (omp), GitHub Copilot (CLI + VS Code), Cursor, and Codex.
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

if (flags.version || cmd === "version") {
  console.log(`convos ${pkg.version}`);
  process.exit(0);
}

// Hidden: full-text search inside conversations (the picker's content mode).
// Lazily imports ./search.ts so that a missing search module never breaks the
// metadata commands (list/_rows/pick) — only this path requires it.
if (cmd === "_search") {
  const query = positional.join(" ").trim();
  const { refreshSearchIndex, searchSessions } = await import("./search.ts");
  const opts: { tool?: string; dir?: string; since?: number; until?: number; limit?: number } = {};
  if (typeof flags.tool === "string") opts.tool = flags.tool;
  if (typeof flags.dir === "string") opts.dir = flags.dir;
  if (typeof flags.since === "string") opts.since = parseTimeArg(flags.since);
  if (typeof flags.until === "string") opts.until = parseTimeArg(flags.until);
  if (typeof flags.limit === "string") {
    const n = Number(flags.limit);
    if (Number.isFinite(n) && n > 0) opts.limit = n;
  }
  // Refresh on entry / direct use; the picker's per-keystroke reload passes
  // --no-refresh to stay fast. An empty query returns recent conversations.
  if (!flags["no-refresh"]) refreshSearchIndex();
  for (const hit of searchSessions(query, opts)) console.log(searchRow(hit));
  process.exit(0);
}

const sessions = applyFilters(buildIndex(), flags);

// Hidden: emit the Phase-1 metadata rows for the picker to reload on ctrl-g.
if (cmd === "_rows") {
  for (const s of sessions) console.log(row(s));
  process.exit(0);
}

if (cmd === "list") plainList(sessions, flags);
else if (cmd === "show") {
  const id = positional[0];
  if (!id) {
    console.error("Usage: convos show <session-id> [--json] [--transcript]");
    process.exit(1);
  }
  const s = findById(id);
  if (!s) {
    console.error("Session not found in index.");
    process.exit(1);
  }
  showSession(s, flags);
} else if (cmd === "export") {
  exportSessions(sessions, flags);
} else if (cmd === "resume") {
  const id = positional[0];
  if (!id) {
    console.error("Usage: convos resume <session-id>");
    process.exit(1);
  }
  const s = findById(id);
  if (!s) {
    console.error("Session not found in index.");
    process.exit(1);
  }
  if (flags["print-cmd"]) {
    const { argv, shell } = sourceByName(s.tool)!.resume(s);
    console.log(JSON.stringify({ argv, shell }, null, 2));
    process.exit(0);
  }
  launch(s);
} else pick(sessions, flags);
