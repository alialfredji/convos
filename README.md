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
  enter: resume · ctrl-y: copy command · ctrl-/: toggle preview
```

## Usage

```
convos                 open the interactive picker (default)
convos list            print a plain table (scriptable)
convos resume <id>     resume one session by id (useful for testing)
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
| **Claude Code**             | `claude --resume <id>`    |
| **OpenCode**                | `opencode --session <id>` |
| **oh-my-pi** (`omp`)        | `omp --resume <id>`       |
| **GitHub Copilot CLI**      | `copilot --resume=<id>`   |
| **GitHub Copilot** (VS Code) | opens the workspace in VS Code † |
| **Cursor**                  | `cursor agent --resume <id>` |

> † VS Code chats are GUI-bound — there is no per-session CLI resume, so
> `convos` opens the workspace folder and the conversation is reachable from the
> tool's chat history.

More tools (Codex, Gemini, …) are designed to drop in — see *Adding a tool*.

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
