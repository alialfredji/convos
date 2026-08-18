# convos

Search and resume your AI coding conversations across every tool, from one place.

You have sessions scattered across directories and tools. At the end of the day
you want to answer: *what did I work on, where, and how do I jump back into it?*
`convos` builds a unified, searchable index of every conversation and lets you
re-enter any of them with one keystroke.

```
$ convos

  convos ▸ databricks
 ┌─────────────────────────────────────────────────────────────────────┐
 │ today 14:32  claude   ~/dev/vibe-code     Query databricks using CLI│
 │ Mon   18:40  claude   ~/dev          Agent skill to query databricks│
 └─────────────────────────────────────────────────────────────────────┘
  enter: resume · ctrl-y: copy · ctrl-f: search inside · ctrl-/: preview
```

## Usage

```
convos                 open the interactive picker (default)
convos list            print a plain table (scriptable)
convos show <id>       print one session (metadata + optional transcript)
convos export          dump many sessions as JSON (for agent review)
convos resume <id>     resume one session by id (useful for testing)
convos --today         only today's conversations
convos --week          conversations from the last 7 days
convos --since <time>  e.g. 7d, 24h, or 2026-06-21
convos --dir <substr>  only conversations from matching directories
convos --tool <name>   only one tool (e.g. claude)
convos --help          full help
```

### Review past sessions with an AI agent

`convos` collects session data; your agent does the analysis. **Prefer low-context formats** to save tokens:

```sh
# 1. Tiny catalog (~10x smaller than --json)
convos list --week --compact

# 2. Markdown digest per session (~5-10x smaller than full JSON)
convos show <session-id> --format digest --transcript

# 3. Batch weekly review
convos export --week --format digest --transcript

# Cursor with lots of [REDACTED]: tools-only timeline
convos export --week --format digest --transcript --tools-only
```

Full JSON when you need every field:

```sh
convos show <session-id> --json --transcript
convos export --week --format jsonl --transcript
```

Point your agent at the JSON output and ask it to review what you worked on, what went well, what failed, and what to improve. `convos` stays focused on discovery and export — not interpretation.

Install the agent skill (teaches any coding agent this workflow):

```sh
npx skills add alialfredji/convos@convos -g -y
```

### Cursor transcripts and `[REDACTED]`

Cursor redacts internal reasoning when persisting agent transcripts. You may see `[REDACTED]` in assistant text on disk — that is Cursor's storage format, not convos hiding content.

`convos` improves on raw files by:

- Stripping `[REDACTED]` markers from visible text
- Exporting `tool_use` blocks under each turn's `tools` array (commands, file reads, patches) — often the best signal when thinking is redacted

### Picker keys

| key      | action                                                            |
|----------|-------------------------------------------------------------------|
| *type*   | fuzzy-search title / directory / tool / date / **first prompt** / month |
| `ctrl-f` | **search inside** conversations — full-text over every transcript |
| `ctrl-g` | return to metadata search                                         |
| `enter`  | `cd` into the directory and resume the conversation               |
| `ctrl-y` | copy the resume command to the clipboard (don't launch)           |
| `ctrl-/` | toggle the transcript preview                                     |

### Two ways to search

The picker opens in **metadata mode**: typing fuzzy-matches each conversation's
title, directory, tool, date, *and* its first prompt (so a phrase you remember
typing finds the session). When you type, results are ranked by match quality;
an empty query keeps recent-first order.

Press `ctrl-f` for **content mode**: every keystroke runs a full-text search
*inside* the transcripts (messages **and** tool calls), ranked by relevance,
with a matching snippet shown on each row. It's backed by a SQLite FTS5 index so
it stays sub-second even over hundreds of conversations. Press `ctrl-g` to go
back. Any active filter (`--tool`, `--dir`, `--since`, …) narrows both modes.

## Supported tools

| tool                  | resumes with            |
|-----------------------|-------------------------|
| **Claude Code**             | `claude --resume <id>`    |
| **OpenCode**                | `opencode --session <id>` |
| **oh-my-pi** (`omp`)        | `omp --resume <id>`       |
| **GitHub Copilot CLI**      | `copilot --resume=<id>`   |
| **GitHub Copilot** (VS Code) | opens the workspace in VS Code † |
| **Cursor**                  | `cursor agent --resume <id>` |
| **Codex** (CLI + Desktop)   | `codex resume <id>`       |

> † VS Code chats are GUI-bound — there is no per-session CLI resume, so
> `convos` opens the workspace folder and the conversation is reachable from the
> tool's chat history.

Codex CLI and Desktop share the same `~/.codex` rollout store. `convos` indexes
their interactive sessions, including archived transcripts, while omitting
non-interactive exec runs and subagent rollouts.

More tools (Gemini, …) are designed to drop in — see *Adding a tool*.

## How it works

- **Sources** (`sources/`) each implement a small interface (`available` /
  `files` / `parse` / `resume` / optional `transcript`). Each tool's storage
  format is read by its own source file.
- **Index cache** (`~/.cache/convos/index.json`) is keyed on each session's
  mtime + size, so only changed sessions are re-parsed — the picker stays fast
  even with hundreds of conversations.
- **Content index** (`~/.cache/convos/search.db`) is a SQLite FTS5 full-text
  index over conversation turns, built lazily the first time you press `ctrl-f`
  and refreshed incrementally (same mtime/size check) — so searching *inside*
  conversations stays sub-second.
- **Resume** runs the tool's own resume command in the session's original
  working directory.

## Get started

```sh
brew install alialfredji/tap/convos
```

Homebrew pulls in `fzf` and compiles `convos` into a single self-contained
binary (the Bun build toolchain is needed only at build time). Then run:

```sh
convos
```

Resuming a session uses that tool's own CLI — e.g. Claude Code sessions resume
with your existing `claude` command.

<details>
<summary><b>From source</b> (for hacking on convos)</summary>

You need [Bun](https://bun.sh) and [fzf](https://github.com/junegunn/fzf):

```sh
brew install oven-sh/bun/bun fzf
```

Then clone and link it into your PATH:

```sh
git clone https://github.com/alialfredji/convos.git
cd convos
./install.sh
```

> If it says `command not found`, add `~/.local/bin` to your PATH (the installer
> prints the exact line to copy), then restart your terminal.

</details>

## Working on the project

Install dependencies:

```sh
npm install
```

Run from source without reinstalling the Homebrew tool:

```sh
npm run dev
```

List sessions for one provider:

```sh
npm run dev -- list --tool cursor
```

Print the exact resume command without launching it:

```sh
npm run dev -- resume <session-id> --print-cmd
```

Actually test that a session resumes:

```sh
npm run dev -- resume <session-id>
```

Run the test suite:

```sh
npm test
```

## Adding a tool

Create `sources/<tool>.ts` implementing `Source`, then register it in
`sources/index.ts`.

Each source should:

- Implement `available()` so missing tools/data do not break indexing.
- Use `files()` + `parse()` for file-backed transcripts, or `scan()` for
  database/bulk sources.
- Return normalized `Session` objects with the provider `tool`, resumable `id`,
  original `dir`, title, timestamps, message count, and backing `file`.
- Implement `resume()` with the exact CLI command needed to reopen the session.
- Add `transcript()` when the picker preview can show useful conversation turns.
- Add or update tests for parsing, transcript preview, and resume command shape.

Validation before pushing:

```sh
npm test
npm run dev -- list --tool <tool>
npm run dev -- resume <session-id> --print-cmd
npm run dev -- resume <session-id>
```

For Cursor specifically, `--print-cmd` should show a command shaped like:

```sh
cursor agent --resume <session-id> --workspace <project-dir>
```
