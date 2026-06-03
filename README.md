# convos

Search and resume your AI coding conversations across every tool, from one place.

You have sessions scattered across directories and tools. At the end of the day
you want to answer: *what did I work on, where, and how do I jump back into it?*
`convos` builds a unified, searchable index of every conversation and lets you
re-enter any of them with one keystroke.

```
$ convos

  convos ▸ cloudflare
 ┌─────────────────────────────────────────────────────────────────────┐
 │ today 14:32  claude   ~/dev/vibe-code     Connect GoDaddy to Cloudflare│
 │ Mon   18:40  claude   ~/dev/zaylas        DNS records for zaylas.store │
 └─────────────────────────────────────────────────────────────────────┘
  enter: resume · ctrl-y: copy command · ctrl-/: toggle preview
```

## Usage

```
convos                 open the interactive picker (default)
convos list            print a plain table (scriptable)
convos --today         only today's conversations
convos --dir <substr>  only conversations from matching directories
convos --tool <name>   only one tool (e.g. claude)
convos --help          full help
```

### Picker keys

| key      | action                                                       |
|----------|--------------------------------------------------------------|
| *type*   | fuzzy-search across title / directory / tool / date          |
| `enter`  | `cd` into the directory and resume the conversation          |
| `ctrl-y` | copy the resume command to the clipboard (don't launch)      |
| `ctrl-/` | toggle the transcript preview                                |

## How it works

- **Sources** (`sources/`) each implement a small interface (`available` /
  `files` / `parse` / `resume`). Claude Code ships today; Codex, OpenCode,
  Gemini, and Cursor are designed to drop in as additional sources.
- **Index cache** (`~/.cache/convos/index.json`) is keyed on each transcript's
  mtime + size, so only changed sessions are re-parsed — the picker stays fast
  even with hundreds of conversations.
- **Resume** for Claude Code runs `claude --resume <id>` in the session's
  original working directory.

## Get started

You need two tools first (one-time):

```sh
brew install oven-sh/bun/bun fzf
```

Then install `convos`:

```sh
git clone https://github.com/alialfredji/convos.git
cd convos
./install.sh
```

That's it. Open a new terminal and run:

```sh
convos
```

> If it says `command not found`, add `~/.local/bin` to your PATH (the installer
> prints the exact line to copy), then restart your terminal.

## Adding a tool

Create `sources/<tool>.ts` implementing `Source`, then register it in
`sources/index.ts`. The picker, cache, search, and resume flow all work
automatically once `parse()` returns normalized `Session` objects.
