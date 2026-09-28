#!/bin/bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
hook_path="$repo_root/.githooks"
existing_path=$(git config --get core.hooksPath || true)

if [[ -n "$existing_path" && "$existing_path" != "$hook_path" ]]; then
  printf 'Existing hooksPath is configured: %s. Integrate the credential hook before replacing it.\n' "$existing_path" >&2
  exit 1
fi

if [[ -z "$existing_path" && -x "$(git rev-parse --git-path hooks/pre-commit)" ]]; then
  printf 'An existing default pre-commit hook is installed. Integrate it before changing hooksPath.\n' >&2
  exit 1
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  printf 'Install gitleaks first (macOS: brew install gitleaks).\n' >&2
  exit 1
fi

if [[ ! -x "$hook_path/pre-commit" ]]; then
  printf 'The tracked .githooks/pre-commit must be executable.\n' >&2
  exit 1
fi

git config --local core.hooksPath "$hook_path"
printf 'Credential scanning enabled for this repository and its worktrees: %s\n' "$hook_path"
