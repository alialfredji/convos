# Releasing & Homebrew

`convos` installs through a personal Homebrew tap:

```sh
brew install alialfredji/tap/convos
```

The formula lives in a **separate** repo — `alialfredji/homebrew-tap` — because
that is what `brew` reads. This file is the runbook for publishing the tap and
cutting releases.

## How the formula works

It compiles `convos.ts` (and its local imports) together with the Bun runtime
into a single self-contained binary via `bun build --compile`. Consequences:

- **Build-time dep:** `bun` (from the `oven-sh/bun` tap; Homebrew auto-taps it).
- **Runtime dep:** `fzf` only. After installing you may `brew autoremove` to drop
  the build copy of bun.
- **Resuming** a session shells out to that tool's own CLI (e.g. `claude`), which
  is *not* a Homebrew dependency — it is the program whose conversations you
  resume, so you already have it.

## One-time: publish the tap

A ready-to-push tap was generated at `../homebrew-tap`. The repo **must** be named
`homebrew-tap` so that `alialfredji/tap/...` resolves.

```sh
cd ../homebrew-tap
git init -b main
git add .
git commit -m "convos 0.1.0"
gh repo create alialfredji/homebrew-tap --public --source=. --remote=origin --push
```

## Cutting a release

1. Bump `version` in `package.json`; commit.
2. Tag and push from this repo:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. Compute the checksum of the tarball GitHub serves for that tag:

   ```sh
   curl -sL https://github.com/alialfredji/convos/archive/refs/tags/v0.1.0.tar.gz \
     | shasum -a 256
   ```

4. In `homebrew-tap/Formula/convos.rb`, point `url` at the new tag and paste the
   `sha256` (replacing `REPLACE_WITH_TARBALL_SHA256`). Commit and push the tap.

5. Verify end to end:

   ```sh
   brew update
   brew install alialfredji/tap/convos
   brew test convos
   brew audit --strict --online convos   # optional, catches style issues
   ```

## Tips

- **Test before tagging:** install straight from `main` with
  `brew install --HEAD alialfredji/tap/convos` (uses the `head` line in the
  formula, no tag or sha256 needed).
- **Future upgrade:** when install volume grows, switch the formula to download
  prebuilt binaries from GitHub Releases (built by a CI workflow) instead of
  compiling on each machine. The runtime story (fzf-only) stays identical; only
  the `install` block changes.
