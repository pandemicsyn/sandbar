---
"@sandbar-sdk/cli": minor
---

Add `sandbar image build`, `image ls`, `image inspect` and `image forget`. On providers that build images first (E2B, Daytona), `--image` uses the build recorded for that reference and profile and fails before creating anything when there is none; `--build` or `images.autoBuild` builds it on demand.
