#!/usr/bin/env bash
# margins — Claude Code skill for roughdraft.md working-doc collaboration.
# Install: curl -fsSL https://raw.githubusercontent.com/recodelabs/margins/main/skills/margins/install.sh | bash
set -euo pipefail

REPO="recodelabs/margins"
REF="${MARGINS_REF:-main}"
SKILL_NAME="margins"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$SKILLS_DIR/$SKILL_NAME"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }

bold "Installing margins skill → $DEST"

mkdir -p "$SKILLS_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TARBALL_URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF"
info "Downloading $TARBALL_URL"
if ! curl -fsSL "$TARBALL_URL" | tar -xz -C "$TMP"; then
  echo "Failed to download $TARBALL_URL" >&2
  exit 1
fi

SRC="$(find "$TMP" -maxdepth 1 -type d -name "margins-*" | head -1)"
SKILL_SRC="$SRC/skills/margins"
if [ -z "$SRC" ] || [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "Couldn't find skills/margins/SKILL.md in downloaded archive" >&2
  exit 1
fi

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  warn "Replacing existing $DEST"
  rm -rf "$DEST"
fi
mkdir -p "$DEST"
cp "$SKILL_SRC/SKILL.md" "$DEST/SKILL.md"

ok "Skill installed: $DEST/SKILL.md"
echo
bold "Done."
info "Restart Claude Code to pick up the new skill."
info "Skill triggers on phrases like: \"do a round of review\", \"rewrite based on my comments\", or any doc with {==...==}{>>...<<} annotations."
