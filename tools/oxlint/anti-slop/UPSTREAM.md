# Anti-slop plugin provenance

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

The `install-anti-slop` skill installed in the primary Sandbar checkout copied its bundled `assets/anti-slop` snapshot into this directory. A file-by-file comparison against `src/` at the commit above found identical production plugin files before the local change below. The skill bundle excludes upstream `*.test.ts` files; those were not copied. The upstream MIT `LICENSE` was added here, and the nested ESLint Stylistic license and provenance remain in `vendor/eslint-stylistic/`.

Sandbar registers both `index.ts` and `effect/index.ts` from `.oxlintrc.json`, with `oxlint` and `@oxlint/plugins` pinned together at `1.85.0`. The Effect rules are enabled at the user's request even though Effect is not yet a direct dependency in this foundation snapshot. Vendored plugin source is excluded from application lint and formatting; upstream tests remain available at the source commit for future rule changes.

Current Effect limitation: `no-service-constructor-imports` checks relative project imports (`./` and `../`). It does not enforce the same restriction through package-alias imports.

Local changes: `effect/rules/prefer-effect-match.ts` reports only strict repeated comparisons of a stable identifier. The upstream rule also matches loose comparisons, repeated calls, and getter reads; replacing those chained tests with one `Match.value(...)` evaluation could change behavior. The local `prefer-effect-match.test.ts` checks these boundaries through the configured Oxlint CLI. `rules/no-module-mocking.ts` also recognizes `vi` and `jest` reached through namespace imports from their test framework packages; `no-module-mocking.test.ts` checks the additional import form. The nested Stylistic provenance was corrected to distinguish upstream tests from tests actually copied into this installation.
