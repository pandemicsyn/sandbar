# Releasing Sandbar packages

`@sandbar-sdk/adapter`, `sandbar-sdk`, `@sandbar-sdk/daytona`, `@sandbar-sdk/e2b`, and `@sandbar-sdk/vercel` use one lockstep version (currently pre-1.0) and one `v<version>` Git tag. Changesets write package changelogs, and the release workflow composes its GitHub release notes from those same version sections. Private apps, SPI, fake-provider and internal packages remain unpublished. Official adapters are public release packages; experimental Modal stays outside this release group.

## Contributor flow

1. Run `bun run changeset` for each public package change. Choose a patch, minor, or major bump and write a short human-readable summary. A prerelease requires an explicit Changesets pre-mode setup and a `next` npm channel; never promote a prerelease to `latest`.
2. Merge the feature PR with its changeset. From `main`, manually run **Prepare package versions**. It fails clearly when no public changesets are pending. It updates `codex/version-packages` with versions, internal ranges, changelogs and `bun.lock`. The lock refresh changes only workspace version fields and verifies a frozen install; it rejects any external resolution or integrity drift.
3. Inspect that branch, run full validation, and obtain the required independent `gpt-6-luna` high review of its complete diff before opening a version PR. Address every finding and review again until none remain. CI and GitHub feedback must clear before the manager merges it. Re-running version preparation changes the branch and invalidates a prior review.

## Operator flow

1. After the reviewed version PR merges, create and push an annotated `v<version>` tag at that exact merged commit. Check that the tag is on `main`; do not move an existing tag.
2. Manually run **Release npm packages** with the tag as `release_ref`, `npm_tag: auto`, and `dry_run: true`. Examine the workflow result and uploaded tarballs. The read-only qualification job repeats lint, format, typecheck, test, build, packed Node/Bun consumers and docs checks. It also installs the tarballs with npm, pnpm and Bun in isolated strict TypeScript consumers, then verifies packed manifest identity, internal dependency ranges, and absence of workspace/file dependencies.
3. After the dry run passes and the npm environment approval is granted, run the same workflow on the same tag with `dry_run: false`. Publication runs in a separate OIDC-enabled job, compares its commit, tarball hashes and notes with the qualification artifact, and stops if they differ. The workflow selects `next` for prereleases and `latest` for stable versions; it rejects prereleases explicitly sent to `latest`. It checks all existing registry versions before publishing. A rerun skips only packages whose existing tarball integrity matches exactly, then completes missing packages. A mismatched version stops the job. If a later package fails, npm versions already published cannot be rolled back; fix the cause and rerun the same tag. The GitHub release is created only after all packages verify in the registry.

## One-time setup before a real release

- Confirm ownership and availability of every public npm package name. The selected public names are `@sandbar-sdk/adapter`, `sandbar-sdk`, `@sandbar-sdk/daytona`, `@sandbar-sdk/e2b`, and `@sandbar-sdk/vercel`. Confirm npm ownership of each name before publication; registry E404 does not prove ownership. The five selected packages have `private: false`, Apache-2.0 licensing and exact repository metadata. Keep internal SPI, fake-provider and app workspaces private; Modal remains experimental outside the coordinated release group. Update `scripts/release-packages.json` and the fixed group in `.changeset/config.json` together if the distributable graph changes.
- Create a protected GitHub `npm` environment with required reviewers and restrict it to approved release tags. Enable Actions to write contents for version preparation; branch protection and the required independent review still apply to the version PR.
- Configure an npm trusted publisher for **each** public package: GitHub owner `pandemicsyn`, repository `sandbar`, workflow filename `release-npm.yml`, environment `npm`, with direct `npm publish` allowed. GitHub-hosted runners, npm CLI 11.5.1+ and Node 22.14+ are required. OIDC requires `id-token: write`; this workflow supplies it. No account credentials are stored in this repository.
- Verify npm organization/scope rights and GitHub environment settings separately. This setup task does not publish packages or create a release.

### npm bootstrap

`npm trust` only accepts packages that already exist, so the package owner runs `bun run release:bootstrap` once from a local checkout with npm 11.15+ and account 2FA enabled. Placeholders are `0.0.0` packages containing only a README, LICENSE and manifest; Changesets never produces `0.0.0`, so they cannot collide with a real release.

1. `bun run release:bootstrap` (or `plan`) reports registry state and packs placeholders without publishing.
2. `npm login` as a member of the `sandbar-sdk` npm organization with publish rights, then `bun run release:bootstrap publish` publishes a placeholder for each package in `scripts/release-packages.json` that is not yet on the registry. It stops if an existing package is not owned by the logged-in account and skips packages the account already owns. npm prompts for 2FA. A brand-new package may be staged instead of going live: npm shows a public `0.0.0-stage` placeholder and holds `0.0.0` under **Staged Packages** on npmjs.com until an owner approves it there (or with `npm stage approve <stage-id>`). Approve each one before the trust step.
3. `bun run release:bootstrap trust` runs `npm trust github` for each package with the settings above. Pass package names (for example `trust @sandbar-sdk/e2b`) to configure only those. npm prompts for 2FA once; choose the option to skip 2FA for the next five minutes. A package holds one trust configuration, so a failed rerun means checking `npm trust list <package>` and revoking a wrong entry before creating it again.
4. On npmjs.com, set each package's **Publishing access** to require two-factor authentication and disallow tokens. Trusted publishing is unaffected.
5. Create the protected GitHub `npm` environment described above before the first real release. A workflow referencing a missing environment creates it without protection.

Placeholders hold `latest` until the first stable release; a prerelease on `next` leaves `latest` on `0.0.0`. Later packages added to the release group follow the same steps.

## Reproducible local qualification

Run `bun run release:fixture` after building packages. It uses temporary package versions and a fake registry; it never contacts npm to publish. The fixture checks stable and prerelease Changesets updates, frozen lock consistency, all three installers, strict types, packed Node/Bun consumers, rejected external lock drift, a partial publish retry, an exact rerun and a conflicting existing version.

## Intended installs after publication

Install core plus the selected official adapter: `npm install sandbar-sdk @sandbar-sdk/daytona` or `npm install sandbar-sdk @sandbar-sdk/e2b` (equivalent pnpm/Bun commands work). Core alone supports independently authored adapters. Its official provider imports are `@sandbar-sdk/daytona`, `@sandbar-sdk/e2b`, and `@sandbar-sdk/vercel`. The Vercel adapter has offline qualification and no live acceptance; its retained metadata and REST-boundary limitations remain documented. The experimental `@sandbar-sdk/modal` adapter is a separate package outside this 1.0 release workflow.

Adapter authors install `@sandbar-sdk/adapter` and import `@sandbar-sdk/adapter/testing` for the conformance suite. These are package shapes for a future authorized publication; no npm release is performed by this task.
