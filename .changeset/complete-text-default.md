---
"sandbar-sdk": minor
---

Decode all captured bytes by default in `stdoutText()` and `stderrText()`, and all supplied bytes in `outputText(bytes)`. Previously these no-argument helpers silently shortened at 16 KiB. Explicit numeric limits and `{ full: true }` remain supported; structured previews retain their 16 KiB default. Capture limits and `truncated` evidence are unchanged, so full decoding cannot recover missing output.

This deliberately changes an unpublished default: read-only npm registry verification on October 11, 2026 returned HTTP 404 for `sandbar-sdk` (local version `0.0.0`). Code relying on implicit display shortening should use `stdoutPreview()` / `stderrPreview()` or an explicit numeric limit.
