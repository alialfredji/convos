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

## Supported tools

| tool                  | resumes with            |
|-----------------------|-------------------------|
| **Claude Code**       | `claude --resume <id>`  |
| **OpenCode**          | `opencode --session <id>` |
| **oh-my-pi** (`omp`)  | `omp --resume <id>`     |

More tools (Codex, Gemini, Cursor, …) are designed to drop in — see *Adding a tool*.

## How it works

- **Sources** (`sources/`) each implement a small interface (`available` /
  `files` / `parse` / `resume` / optional `transcript`). Each tool's storage
  format is read by its own source file.
- **Index cache** (`~/.cache/convos/index.json`) is keyed on each session's
  mtime + size, so only changed sessions are re-parsed — the picker stays fast
  even with hundreds of conversations.
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

## Adding a tool

Create `sources/<tool>.ts` implementing `Source`, then register it in
`sources/index.ts`. The picker, cache, search, and resume flow all work
automatically once `parse()` returns normalized `Session` objects.
