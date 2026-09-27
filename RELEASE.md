# Releasing Sandbar packages

The public library graph uses one lockstep `0.x` version and one `v<version>` Git tag. Changesets write package changelogs, and the release workflow composes its GitHub release notes from those same version sections. Private apps and server storage packages remain unversioned and unpublished.

## Contributor flow

1. Run `bun run changeset` for each public package change. Choose a patch, minor, or major bump and write a short human-readable summary. A prerelease requires an explicit Changesets pre-mode setup and a `next` npm channel; never promote a prerelease to `latest`.
2. Merge the feature PR with its changeset. From `main`, manually run **Prepare package versions**. It fails clearly when no public changesets are pending. It updates `codex/version-packages` with versions, internal ranges, changelogs and `bun.lock`. The lock refresh changes only workspace version fields and verifies a frozen install; it rejects any external resolution or integrity drift.
3. Inspect that branch, run full validation, and obtain the required independent `gpt-6-luna` high review of its complete diff before opening a version PR. Address every finding and review again until none remain. CI and GitHub feedback must clear before the manager merges it. Re-running version preparation changes the branch and invalidates a prior review.

## Operator flow

1. After the reviewed version PR merges, create and push an annotated `v<version>` tag at that exact merged commit. Check that the tag is on `main`; do not move an existing tag.
2. Manually run **Release npm packages** with the tag as `release_ref`, `npm_tag: auto`, and `dry_run: true`. Examine the workflow result and uploaded tarballs. The read-only qualification job repeats lint, format, typecheck, test, build, packed Node/Bun consumers and docs checks. It also installs the tarballs with npm, pnpm and Bun in isolated strict TypeScript consumers, then verifies packed manifest identity, internal dependency ranges, and absence of workspace/file dependencies.
3. After the dry run passes and the npm environment approval is granted, run the same workflow on the same tag with `dry_run: false`. Publication runs in a separate OIDC-enabled job, compares its commit, tarball hashes and notes with the qualification artifact, and stops if they differ. The workflow selects `next` for prereleases and `latest` for stable versions; it rejects prereleases explicitly sent to `latest`. It checks all existing registry versions before publishing. A rerun skips only packages whose existing tarball integrity matches exactly, then completes missing packages. A mismatched version stops the job. If a later package fails, npm versions already published cannot be rolled back; fix the cause and rerun the same tag. The GitHub release is created only after all packages verify in the registry.

## One-time setup before a real release

- Confirm ownership and availability of every public npm package name. The repository's current `@sandbar/*` names are provisional; `sandbar` is occupied. Set `private: false`, exact repository metadata and public access only on the agreed public graph. Keep service and app packages private. Update `scripts/release-packages.json` and the fixed group in `.changeset/config.json` together.
- Create a protected GitHub `npm` environment with required reviewers and restrict it to approved release tags. Enable Actions to write contents for version preparation; branch protection and the required independent review still apply to the version PR.
- Configure an npm trusted publisher for **each** public package: GitHub owner `pandemicsyn`, repository `sandbar`, workflow filename `release-npm.yml`, environment `npm`, with direct `npm publish` allowed. GitHub-hosted runners, npm CLI 11.5.1+ and Node 22.14+ are required. OIDC requires `id-token: write`; this workflow supplies it. The npm `trust` command requires an existing package, so each first publication needs an authorized manual bootstrap with package ownership and a suitable scoped/public access setting before OIDC can be configured. No account credentials are stored in this repository.
- Verify npm organization/scope rights and GitHub environment settings separately. This setup task does not publish packages or create a release.

## Reproducible local qualification

Run `bun run release:fixture` after building packages. It uses temporary package versions and a fake registry; it never contacts npm to publish. The fixture checks stable and prerelease Changesets updates, frozen lock consistency, all three installers, strict types, packed Node/Bun consumers, rejected external lock drift, a partial publish retry, an exact rerun and a conflicting existing version.
