# Releasing Sandbar packages

`@sandbar-sdk/adapter`, `sandbar-sdk`, `@sandbar-sdk/daytona`, `@sandbar-sdk/e2b`, `@sandbar-sdk/boxd`, `@sandbar-sdk/boat` (experimental), `@sandbar-sdk/modal` (experimental), `@sandbar-sdk/vercel`, and `@sandbar-sdk/cli` use one lockstep version (currently pre-1.0) and one `v<version>` Git tag. Changesets write package changelogs, and the release workflow composes its GitHub release notes from those same version sections. Private apps, SPI, fake-provider and internal packages remain unpublished. Official and experimental adapters are public release packages.

## Contributor flow

1. Run `bun run changeset` for each public package change. Choose a patch, minor, or major bump and write a short human-readable summary. A prerelease requires an explicit Changesets pre-mode setup and a `next` npm channel; never promote a prerelease to `latest`.
2. Merge the feature PR with its changeset. Every push to `main` that changes `.changeset/**` runs **Prepare package versions**, which opens or updates the `chore: version packages` PR (branch `changeset-release/main`) with versions, internal ranges, changelogs and `bun.lock`. The lock refresh changes only workspace version fields and verifies a frozen install; it rejects any external resolution or integrity drift.
3. Review the version PR like any other change. PRs opened by the workflow token do not trigger CI; the release qualification below repeats every check before anything publishes.

## Operator flow

1. Merge the version PR. The push to `main` changes package versions, so **Release npm packages** starts automatically. Its plan job releases only when no `v<version>` tag exists yet; other `package.json` changes are skipped.
2. The qualification job repeats lint, format, typecheck, test, build, packed Node/Bun consumers and docs checks, and installs the tarballs with npm, pnpm and Bun in isolated strict TypeScript consumers.
3. Approve the `npm` environment when the publish job waits. It creates the `v<version>` tag on the qualified commit, then publishes all packages over OIDC and waits once for the registry to show them. It compares its commit, tarball hashes and notes with the qualification artifact and stops if they differ. `latest` is used for stable versions and `next` for prereleases. A rerun skips packages whose existing tarball integrity matches exactly and completes the rest; published versions cannot be rolled back. The GitHub release is created only after all packages verify.

Manual runs check out the ref they run on. Qualify a branch with `gh workflow run release-npm.yml --ref main -f dry_run=true`; publish an existing tag with `gh workflow run release-npm.yml --ref v<version> -f dry_run=false`.

## One-time setup before a real release

- Confirm ownership and availability of every public npm package name. The selected public names are `@sandbar-sdk/adapter`, `sandbar-sdk`, `@sandbar-sdk/daytona`, `@sandbar-sdk/e2b`, `@sandbar-sdk/boxd`, `@sandbar-sdk/boat` (experimental), `@sandbar-sdk/modal` (experimental), `@sandbar-sdk/vercel`, and `@sandbar-sdk/cli`. Confirm npm ownership of each name before publication; registry E404 does not prove ownership. The nine selected packages have `private: false`, Apache-2.0 licensing and exact repository metadata. Keep internal SPI, fake-provider and app workspaces private. Update `scripts/release-packages.json` and the fixed group in `.changeset/config.json` together if the distributable graph changes.
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

Placeholders hold `latest` until the first stable release; a prerelease on `next` leaves `latest` on `0.0.0`. Later packages added to the release group follow the same steps before the version PR that first releases them is merged. The publish job checks this first: if any package is not on npm yet it stops before publishing anything. After bootstrapping, rerun the failed publish job.

## Reproducible local qualification

Run `bun run release:fixture` after building packages. It uses temporary package versions and a fake registry; it never contacts npm to publish. The fixture checks stable and prerelease Changesets updates, frozen lock consistency, all three installers, strict types, packed Node/Bun consumers, rejected external lock drift, a partial publish retry, an exact rerun and a conflicting existing version.

## Intended installs after publication

Install core plus the selected official adapter: `npm install sandbar-sdk @sandbar-sdk/daytona` or `npm install sandbar-sdk @sandbar-sdk/e2b` (equivalent pnpm/Bun commands work). Core alone supports independently authored adapters. Its official provider imports are `@sandbar-sdk/daytona`, `@sandbar-sdk/e2b`, `@sandbar-sdk/boxd`, and `@sandbar-sdk/vercel`. The Vercel adapter has offline qualification and no live acceptance; its retained metadata and REST-boundary limitations remain documented. The command line installs with `npm install -g @sandbar-sdk/cli` and loads adapters at run time from `~/.config/sandbar/adapters`, so it ships no adapter. The experimental `@sandbar-sdk/modal` adapter is released with the same workflow.

Adapter authors install `@sandbar-sdk/adapter` and import `@sandbar-sdk/adapter/testing` for the conformance suite.
