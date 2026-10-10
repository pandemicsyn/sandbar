# Runnable agent examples

Implemented scope and acceptance · October 10, 2026 · OpenCode on Daytona and E2B

## Goal and scope

Add two runnable TypeScript applications under root `examples/` using public Sandbar SDK entrypoints and OpenCode's headless `run --pure` CLI with isolated configuration/data/cache directories. Both workflows select Daytona or E2B through configuration. Provider mechanics belong in shared adapter setup; ordinary SDK execution, file operations and cleanup remain visible in the entrypoints.

1. Create a sandbox, install pinned OpenCode, ask **“What is 2 + 2?”**, capture stdout/stderr and print the response. Do not ask for or write an answer file.
2. Upload the local `message.txt` fixture containing `Hello, NAME!\n`. Ask OpenCode to replace `NAME` with `Sandbar`, leaving the rest unchanged. Capture its output, read the remote file through Sandbar and display `Hello, Sandbar!\n`. Preserve the local fixture.

Use bounded `exec()` calls. A provider-specific plugin, native SDK in workflow code, PTY, agent framework, server, repository integration and broader agent tasks are outside this slice.

## Setup and lifecycle

Use a private examples workspace with `hello` and `edit` scripts, a shared provider setup and a pinned OpenCode installer/configuration helper. Scripts explicitly load `examples/.env.local`. Document checkout installation and package builds with Bun 1.3.14 while Sandbar packages are unpublished.

Select the model explicitly. Pin `opencode-ai@1.18.35` and select `opencode/nemotron-3.5-lightning-free`, confirmed in the current public model catalog and Zen documentation on October 10, 2026; do not require an Anthropic credential. Support keyed models only through the implementation's explicit environment allowlist, keeping model credentials separate from sandbox credentials. Do not forward the entire host environment or expose secrets in arguments or ordinary logs. Anonymous service availability can change, and model selection must remain configurable.

Document image requirements, a writable working directory and outbound access for npm installation/model requests. E2B uses `internet`; Daytona uses `daytona-default` on connection and creation, subject to organization restrictions. No custom image build is required.

Use finite sandbox lifetimes and bounded installation/execution waits. Destroy owned sandboxes and close clients in `finally`, including bounded cleanup after Ctrl+C. Preserve primary errors and known resource identities if cleanup fails. Local cancellation and client closure alone do not prove sandbox destruction. Do not automatically replay uncertain creation or execution.

## Acceptance and status

Implemented with offline entrypoint/fixture validation and successful local anonymous CLI checks for both tasks using the pinned version and model. Daytona/E2B live qualification remains unrun. The [roadmap](../ROADMAP.md) owns delivery status; the [runnable guide](../examples/README.md) owns exact commands and configuration.

- Both real entrypoints typecheck against public SDK exports. Deterministic tests cover relevant configuration, captured output, fixture transfer/read-back and failure cleanup without paid resources or model calls.
- The README gives exact provider/model configuration, image/network prerequisites, expected results, finite lifecycle and cleanup behavior. It distinguishes anonymous model access from sandbox compute costs.
- Separately authorized live acceptance runs both examples on Daytona and E2B, verifies the answer and changed file, and confirms cleanup. Record SDK revision, OpenCode version, model and provider configuration. A fake agent validates wiring; it cannot qualify real OpenCode/model integration.

Live sandbox calls and paid resources require separate authorization. This scope does not authorize publication or deployment. Describe live support only for recorded passing configurations; offline checks do not establish live support.

## References

- [OpenCode CLI](https://opencode.ai/docs/cli/#run) — headless prompt execution.
- [OpenCode models](https://opencode.ai/docs/models/) — explicit model selection.
- [OpenCode Zen](https://opencode.ai/docs/zen/) — model availability and authentication.
- [Daytona OpenCode guide](https://www.daytona.io/docs/en/guides/opencode/opencode-sdk-agent/) — agent execution inside a sandbox; these examples use the simpler CLI flow.
