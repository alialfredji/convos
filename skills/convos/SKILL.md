---
name: convos
description: >-
  Search, filter, and export AI coding session transcripts across Claude Code,
  Cursor, OpenCode, Copilot, and other tools via the convos CLI. Use when the
  user wants to review past agent sessions, list conversations from a time
  range, export transcripts for retrospective analysis, resume a session, or
  learn from previous AI-assisted work.
---

# convos

Collect session data with `convos`. Your agent analyzes it — convos does not.

## Install

```sh
brew install alialfredji/tap/convos
# or from source: git clone …/convos && ./install.sh
```

Install this skill globally:

```sh
npx skills add alialfredji/convos@convos -g -y
```

## Workflow

Prefer **low-context** exports. Use full JSON only when you need every field.

### 1. Catalog sessions (tiny)

```sh
convos list --week --compact
convos list --since 7d --tool cursor --compact
```

Returns minimal JSON: `id`, `tool`, `dir`, `title`, `msgs`, `end`, `prompt` — no file paths, resume commands, or timestamps in ms.

### 2. Pull one session (digest)

```sh
convos show <session-id> --format digest --transcript
```

Markdown timeline — typically **5–10× smaller** than `--json --transcript`. Best default for agent review.

```sh
convos show <session-id> --format digest --transcript --tools-only
```

For Cursor sessions: user prompts + tool calls only (skips redacted assistant prose).

### 3. Batch export

```sh
convos export --week --format digest --transcript
convos export --week --format compact --transcript
```

- `digest` — markdown blocks separated by `---` (smallest for reading)
- `compact` — single-line JSON array with `timeline` string lines

### 4. Full detail (high context — use sparingly)

```sh
convos show <session-id> --json --transcript
convos export --week --format jsonl --transcript
```

## Compaction flags

| Flag | Effect |
|------|--------|
| `--compact` | Short paths, truncate text, collapse tool turns |
| `--format digest` | Markdown timeline instead of JSON |
| `--format compact` | Minimal JSON with string timeline |
| `--tools-only` | User messages + tool calls only |
| `--max-chars 200` | Cap text per turn (default 280 with `--compact`) |
| `--collapse-tools` | Merge consecutive tool-only turns |
| `--no-collapse` | Disable tool-turn merging |

## Filters

| Flag | Example | Meaning |
|------|---------|---------|
| `--week` | `--week` | Last 7 days |
| `--since` | `--since 7d` | Relative (`7d`, `24h`, `30m`) or ISO date |
| `--until` | `--until 3d` | Upper time bound |
| `--tool` | `--tool cursor` | One provider |
| `--dir` | `--dir convos` | Directory substring match |
| `--limit` | `--limit 20` | Cap results (newest first) |

## Analysis pattern

convos provides data only. After export:

1. Start with `--compact` catalog, then `--format digest` for interesting sessions
2. Group by `dir` or `tool` to see where time went
3. Read `prompt` + timeline to understand intent vs outcome
4. For Cursor, use `--tools-only` when assistant text is mostly redacted
5. Escalate to `--json --transcript` only for one session that needs full tool inputs
6. Write learnings — convos does not judge quality

## Cursor `[REDACTED]` notes

Cursor redacts internal reasoning in on-disk transcripts. convos cannot recover redacted text.

- Visible assistant preamble is kept; trailing `[REDACTED]` is stripped
- `tool_use` blocks are exported in full under `tools` — use these for retrospective review
- Older Cursor sessions may include fuller assistant text
- Final user-facing replies are usually complete; mid-session thinking is often redacted

## Resume (interactive)

```sh
convos                          # fzf picker
convos resume <id> --print-cmd  # inspect command
convos resume <id>              # launch
```

## Requirements

- `convos` on PATH (`brew install alialfredji/tap/convos`)
- `fzf` only for the interactive picker (not needed for `list` / `show` / `export`)
