#!/usr/bin/env bash
# Installs the `convos` command. Run from the project folder: ./install.sh
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin"

# 1. Check the two things convos needs.
command -v bun >/dev/null || { echo "✗ bun not found. Install it:  brew install oven-sh/bun/bun"; exit 1; }
command -v fzf >/dev/null || { echo "✗ fzf not found. Install it:  brew install fzf"; exit 1; }

# 2. Link the command into your PATH.
mkdir -p "$BIN"
chmod +x "$HERE/convos.ts"
ln -sf "$HERE/convos.ts" "$BIN/convos"
echo "✓ Installed: $BIN/convos"

# 3. Make sure ~/.local/bin is on your PATH.
case ":$PATH:" in
  *":$BIN:"*) echo "✓ Ready. Run:  convos" ;;
  *) echo "→ Add this line to your ~/.zshrc, then restart your terminal:"
     echo "    export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
