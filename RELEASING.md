# Releasing

This repository publishes two independent npm packages from one branch:

| Directory | Package | Targets | Source |
|---|---|---|---|
| `/` | `opencode-dynamic-custom-providers` (`2.x`) | OpenCode V1 | `src/*.ts` (excludes `src/v2`) |
| `packages/v2` | `opencode-dynamic-custom-providers-v2` (`0.x`) | OpenCode V2 (`@opencode/plugin` 2.0.21) | `src/v2/*.ts` only |

Never move `latest` of `opencode-dynamic-custom-providers` to a V2-only build: unpinned V1
users would break. Each package keeps its own version line, changelog and `latest` tag.

## No shared code

The packages share no source. V2 has its own discovery (`src/v2/discover.ts`: caller
cancellation, same-origin-only redirects, no remote bodies in diagnostics) and its own
redaction/URL policy (`src/v2/secure.ts`); the V1 `src/discovery.ts` and `src/security.ts` are
compiled into the V1 package only. Changes to V1 files never change the V2 package and vice versa.

## V1 package

```bash
npm install          # the committed lock predates npm 11 optional-platform entries; `npm ci` refuses it
npm test             # tsc + V1 node tests
npm pack             # inspect: only dist/, README.md, LICENSE, package.json
npm publish          # when authorized
```

## V2 package

```bash
cd packages/v2
npm ci               # own lockfile; dev deps pin @opencode/plugin 2.0.21 for types
npm test             # tsc -p tsconfig.json + node --test ../../tests/v2/*.test.mjs
npm pack             # prepack builds dist/; expect dist/v2/* only. Build from a clean dist/
                     # (move an old one aside): tsc does not delete stale outputs.
```

Bump `version` in `packages/v2/package.json` and `packages/v2/CHANGELOG.md` **before** the final
`npm pack`: a bump produces a different tarball, and the tarball verified below must be the one
published (any later byte change means repack and verify again).

Before publishing, verify from the tarball (not the workspace):

1. Production closure: install the `.tgz` with `npm install --omit=dev --ignore-scripts` into an
   empty directory and import `opencode-dynamic-custom-providers-v2`, `/server`, `/tui`, `/rpc`.
   Only `jsonc-parser` should be installed.
2. Host load: in an isolated HOME, reference the tarball as `"plugins": ["file:/abs/path.tgz"]`
   and run `opencode serve` (`@opencode/cli` of the targeted version); `GET /api/plugin` must show
   `opencode-dynamic-custom-providers-v2` `active` with `server`, `tui`, `rpc` features, and the
   TUI `/plugins` dialog must not list a failed TUI plugin.

Then, when authorized: `npm publish <verified .tgz>` (that exact tarball) from `packages/v2`
(first publish of the name needs the package name to be available and owned by the publishing
account).

## Retargeting a new OpenCode V2 release

The V2 plugin API is pre-1.0 in practice. To target a newer release, bump the pinned
`@opencode/plugin` dev dependency and `peerDependencies`, re-run the type check, the V2 tests, and
the host-load UAT above. Known 2.0.21 host behaviours the code depends on are commented in
`src/v2/` (fold order independence, no JSON Schema `pattern`, keymap layers from a mounted slot).
