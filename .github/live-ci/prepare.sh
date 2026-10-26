#!/bin/sh
# Runs inside the sandbox, in the pushed checkout: installs the repo's Bun and its dependencies.
# Safe to run again; on a warm base both steps find their work already done.
set -eu

BUN_VERSION=1.3.14
export PATH="$HOME/.bun/bin:$PATH"

if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$arch.zip"
  # Not every base image has unzip; python3 is the fallback.
  if command -v unzip >/dev/null; then
    unzip -q "$tmp/bun.zip" -d "$tmp"
  else
    python3 -m zipfile -e "$tmp/bun.zip" "$tmp"
  fi
  mkdir -p "$HOME/.bun/bin"
  mv "$tmp/bun-linux-$arch/bun" "$HOME/.bun/bin/bun"
  chmod +x "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
fi

bun --version
bun install --frozen-lockfile
