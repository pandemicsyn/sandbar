# Credential scanning

Run `bash scripts/setup-hooks.sh` after cloning. Gitleaks must be installed (`brew install gitleaks` on macOS).

The pre-commit hook scans staged changes with default Gitleaks rules plus Daytona/E2B key-assignment detection. Findings are redacted. It also blocks forced-staged `.env` and `.env.*` files, except `.env.example`, and refuses commits if Gitleaks is unavailable.

Installation sets an absolute local `core.hooksPath`, covering this checkout and its managed worktrees even before they contain these tracked files. Keep the installing checkout available; rerun setup if it moves. Existing configured hook paths are preserved until explicitly integrated.

Keep real keys in the ignored `.env.local`. Do not add broad allowlists to suppress a finding; replace test credentials with unmistakable placeholders or review a narrowly scoped fixture exception. A local hook can be bypassed and does not replace server-side scanning.
