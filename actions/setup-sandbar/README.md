# setup-sandbar

Installs the Sandbar CLI and provider adapters in a GitHub Actions job, and removes the sandboxes the job created when it ends.

```yaml
- uses: pandemicsyn/sandbar/actions/setup-sandbar@main
  with:
    version: 0.7.0
    adapters: e2b
    provider: e2b
- run: sandbar run --push . --network internet --timeout 15m -- sh -c 'npm ci && npm test'
```

Inputs: `version` (default `latest`), `adapters`, `provider`, `state-dir` and `cleanup` (default `true`). Put provider credentials in the job's `env` so the cleanup step can reach the provider.

See [Run CI jobs](https://sandbarsdk.dev/docs/cli/ci/) for the full guide, including warm bases, retries and time limits.
