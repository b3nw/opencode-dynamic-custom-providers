# Releasing

This repository publishes two independent, unscoped, public npm packages to
`https://registry.npmjs.org/` from one branch:

| Track | Directory | Package | Targets | Source | Release tag |
|---|---|---|---|---|---|
| V1 | `/` | `opencode-dynamic-custom-providers` (`2.x`) | OpenCode V1 | `src/*.ts` (excludes `src/v2`) | `v1-plugin-v<version>` |
| V2 | `packages/v2` | `opencode-dynamic-custom-providers-v2` (`1.x`) | OpenCode V2 (`@opencode/plugin` 2.0.21) | `src/v2/*.ts` only | `v2-plugin-v<version>` |

Each package has its own version line, changelog, lockfile and `latest` dist-tag. Never move
`latest` of `opencode-dynamic-custom-providers` to a V2-only build: unpinned V1 users would break.
Nothing is published to GitHub Packages, PyPI or any other registry, and no names are reserved
ahead of time.

## No shared code

The packages share no source. V2 has its own discovery (`src/v2/discover.ts`: caller
cancellation, same-origin-only redirects, no remote bodies in diagnostics) and its own
redaction/URL policy (`src/v2/secure.ts`); the V1 `src/discovery.ts` and `src/security.ts` are
compiled into the V1 package only. Changes to V1 files never change the V2 package and vice versa.
V2 compiles `../../src/v2` and its tests live in `tests/v2`, so V2 builds need the whole repository
checked out, not just `packages/v2`.

## CI (`.github/workflows/ci.yml`)

Runs on every branch push and pull request (and manually), with `contents: read` only, no secrets
and no OIDC. Independent jobs on GitHub-hosted `ubuntu-24.04`, Node `24.21.0` / npm `11.19.0`
(asserted), no dependency cache:

- `helpers`: `node --test scripts/ci/release.test.mjs` (tag selection, version mismatch, invalid
  tags, prerelease dist-tags, tarball boundaries, and the publish jobs' registry guard: the real
  `run:` script from `publish.yml` against a local fake registry with `npm` shimmed).
- `v1`: `npm ci --ignore-scripts` → `npm test` → pack once → boundary check → production-only
  consumer install/import → artifact `npm-v1-tarball`.
- `v2`: in `packages/v2`: `npm ci --ignore-scripts` → `npm run typecheck` → `npm test` → pack once →
  boundary check → consumer install/import → artifact `npm-v2-tarball`.
- `release-dry-run` (manual `workflow_dispatch` with `release_tag`): validates a planned tag against
  the manifests and the registry's current `latest`. It never publishes or authenticates.

The same checks run locally, from a clean checkout:

```bash
node --test scripts/ci/release.test.mjs

npm ci --ignore-scripts && npm test
node scripts/ci/release.mjs pack --track v1 --out-dir /tmp/pack-v1
node scripts/ci/release.mjs verify-tarball --track v1 --tarball /tmp/pack-v1/opencode-dynamic-custom-providers-<version>.tgz
node scripts/ci/release.mjs verify-consumer --track v1 --tarball /tmp/pack-v1/opencode-dynamic-custom-providers-<version>.tgz

(cd packages/v2 && npm ci --ignore-scripts && npm run typecheck && npm test)
node scripts/ci/release.mjs pack --track v2 --out-dir /tmp/pack-v2
node scripts/ci/release.mjs verify-tarball --track v2 --tarball /tmp/pack-v2/opencode-dynamic-custom-providers-v2-<version>.tgz
node scripts/ci/release.mjs verify-consumer --track v2 --tarball /tmp/pack-v2/opencode-dynamic-custom-providers-v2-<version>.tgz
```

`pack` uses `npm pack --ignore-scripts`, so the tarball holds the build the tests just ran
(`prepare`/`prepack` cannot rebuild it). `tsc` does not delete stale outputs: pack from a clean
checkout or remove `dist/` first. The boundary check enforces:

- V1: only `package.json`, `README.md`, `LICENSE` and flat `dist/*.js|*.d.ts` (no `dist/v2`).
- V2: only `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md` and `dist/v2/*.js|*.d.ts`.
- Never sources, tests, scripts, configs, symlinks or nested build output; packed name/version
  equal the manifest; every `exports`/`main`/`types` target is present; canonical
  `repository.url`; no `preinstall`/`install`/`postinstall`.

The consumer check installs the tarball into an empty directory with
`npm install --omit=dev --ignore-scripts`, checks the installed name/version, rejects dev-only
dependencies in the closure (V2: only `jsonc-parser` may be installed) and imports every public
entry point.

## Release workflow (`.github/workflows/publish.yml`)

Triggered only by pushing a tag matching `v1-plugin-v*` or `v2-plugin-v*`. Never by branch pushes,
pull requests or `workflow_dispatch`; there is no `pull_request_target`.

1. `verify` (`contents: read`, no secrets, no OIDC) at the exact tagged commit:
   - parses the full tag strictly (`v1-plugin-v` / `v2-plugin-v` + SemVer `X.Y.Z[-prerelease]`, no
     `v` inside the version, no leading zeros, no `+build`) and requires the selected manifest's
     `name`, `version` and `repository.url` to match. Any other tag fails here, before anything
     privileged runs;
   - requires the tagged commit to be an ancestor of the default branch (`main`);
   - stable versions publish to `latest`, prereleases (`X.Y.Z-anything`) to `next`. A stable version
     lower than the registry's current `latest` is refused (anonymous registry read);
   - frozen install, typecheck (V2), tests, pack once, boundary + consumer checks, SHA-256 recorded,
     tarball uploaded as artifact `npm-release-tarball`.
2. `publish-v1` **or** `publish-v2` (only the job matching the selected track runs; the other is
   skipped). It runs in the GitHub environment `npm-release-v1` / `npm-release-v2` and is the only
   job with `id-token: write`. It checks out no code and runs no build: it downloads the artifact,
   re-checks the SHA-256 and the packed name/version against the job's hard-coded package name,
   then re-reads the registry on every attempt, including *Re-run failed jobs* (which skips
   `verify` and its `latest` check):
   - the version is already published with identical bytes (`dist.integrity`): success, nothing
     published; with different bytes: fail;
   - otherwise a fresh, uncached read of the dist-tags: a stable version must be strictly above the
     current `latest`, or the job fails without publishing. This is needed because npm's own
     "Cannot implicitly apply the latest tag" protection (npm 11.19.0) only applies when `--tag` is
     omitted; with the explicit `--tag latest` used here npm would move `latest` backwards;
   - any registry error, timeout, non-JSON or malformed response, or packument/dist-tags
     disagreement fails closed. Malformed includes a `latest` that is not a strict SemVer string
     (build metadata is accepted and ignored for ordering) and a successful packument without a
     non-empty `versions` object. Only a genuine "not found" on both reads counts as an unpublished
     package (first publish).

   Then it runs:

   ```bash
   npm publish ./<name>-<version>.tgz --access public --tag <latest|next> \
     --registry https://registry.npmjs.org/ --provenance --ignore-scripts
   ```

   Authentication is npm trusted publishing (OIDC) only. No `NPM_TOKEN` or other secret exists in
   the workflow, and none should be added.

Releases are serialized per track (`npm-publish-v1` / `npm-publish-v2` concurrency groups, never
cancelled in progress). GitHub keeps at most one *pending* run per group, so if a third release of
the same track is pushed while one runs and one waits, the waiting one is cancelled: re-run it.

## One-time setup (owner, outside this repository)

The workflow file only names the environments. Approval and tag restrictions exist only after
they are configured in GitHub; npm trusts the workflow only after it is configured on npmjs.com.

### GitHub (repository → Settings)

1. **Environments** → create `npm-release-v1` and `npm-release-v2`. For each:
   - *Required reviewers*: add the maintainer(s) who approve releases (`b3nw`).
   - *Deployment branches and tags*: **Selected branches and tags** → add a **tag** rule
     `v1-plugin-v*` (for `npm-release-v1`) or `v2-plugin-v*` (for `npm-release-v2`). No branch rules.
   - Add no secrets.
2. **Rules → Rulesets** (recommended): a tag ruleset targeting `v1-plugin-v*` and `v2-plugin-v*`
   that restricts creation, update and deletion to maintainers, so release tags cannot be created or
   moved by others.
3. **Actions → General**: keep the default `GITHUB_TOKEN` read-only.

### npm trusted publishers (npmjs.com → package → Settings → Trusted publishing)

One GitHub Actions trusted publisher per package (fields are case-sensitive):

| Package | Organization or user | Repository | Workflow filename | Environment |
|---|---|---|---|---|
| `opencode-dynamic-custom-providers` | `b3nw` | `opencode-dynamic-custom-providers` | `publish.yml` | `npm-release-v1` |
| `opencode-dynamic-custom-providers-v2` | `b3nw` | `opencode-dynamic-custom-providers` | `publish.yml` | `npm-release-v2` |

- **Allowed actions**: publishers created after 2026-09-03 only allow `npm stage publish` by default.
  This workflow uses direct `npm publish`, so explicitly allow **npm publish**. (Leave dist-tag
  management off; the workflow does not use it.) If you prefer stage-only, the workflow must be
  changed to `npm stage publish` and every release approved on npmjs.com.
- A new trusted publisher must complete its first successful publish within **2 days** or it
  expires (delete and recreate it, then release again).
- npm does not validate the configuration when saved; mistakes show up as `ENEEDAUTH` at publish.
- `repository.url` in each `package.json` must stay
  `git+https://github.com/b3nw/opencode-dynamic-custom-providers.git` (provenance is checked against
  it; the helper enforces this).
- After the first OIDC release works: package → Settings → Publishing access → *Require two-factor
  authentication and disallow tokens*, and revoke unused automation tokens.

Trusted publishing requires a GitHub-hosted runner, Node >= 22.14.0 and npm >= 11.5.1 (the
workflow pins Node 24.21.0 / npm 11.19.0). The repository is public, so npm attaches provenance.

### Bootstrap: first V2 publish

A trusted publisher can only be configured for a package that already exists on npm.
`opencode-dynamic-custom-providers` exists, so its publisher can be configured right before its
first workflow release (mind the 2-day window). `opencode-dynamic-custom-providers-v2` does not
exist yet: its first version needs one authenticated publish by the owner. Publish the tarball the
workflow verified rather than a local rebuild:

1. Configure the `npm-release-v2` environment with required reviewers first (so the publish job
   waits instead of failing).
2. Merge the release commit to `main`, then tag and push it: `git tag -a v2-plugin-v1.0.0 -m
   "opencode-dynamic-custom-providers-v2 1.0.0" <merge-commit> && git push origin v2-plugin-v1.0.0`.
3. When `verify` is green and `publish-v2` waits for approval, download the verified tarball and
   check it against the SHA-256 printed by the `Pack once` step:

   ```bash
   gh run download <run-id> -n npm-release-tarball -D /tmp/v2-bootstrap
   sha256sum /tmp/v2-bootstrap/opencode-dynamic-custom-providers-v2-1.0.0.tgz
   node scripts/ci/release.mjs verify-tarball --track v2 --tarball /tmp/v2-bootstrap/opencode-dynamic-custom-providers-v2-1.0.0.tgz
   ```

4. Publish it from the owner's logged-in npm account (interactive 2FA):

   ```bash
   npm publish /tmp/v2-bootstrap/opencode-dynamic-custom-providers-v2-1.0.0.tgz --access public \
     --tag latest --registry https://registry.npmjs.org/ --ignore-scripts
   ```

5. Approve the waiting `publish-v2` job (it finds the identical tarball already published and
   succeeds without publishing) or reject it.
6. Configure the V2 trusted publisher (table above) and make the next V2 release through the
   workflow within 2 days. That first manual version has no provenance; every later release of
   either package is OIDC-only.

## Releasing a version (both tracks, after setup)

Bump on a branch, merge to `main`, then tag the merge result. The tag must point at a commit on
`main`, and the tag version must equal the package's `version`.

V1 (repository root):

```bash
npm version 2.3.0 --no-git-tag-version          # updates package.json + package-lock.json
# edit CHANGELOG.md: move [Unreleased] under [2.3.0] - YYYY-MM-DD
git commit -am "chore(release): opencode-dynamic-custom-providers 2.3.0"
# open PR, wait for CI, merge to main, then on the merged commit:
git tag -a v1-plugin-v2.3.0 -m "opencode-dynamic-custom-providers 2.3.0" <merge-commit>
git push origin v1-plugin-v2.3.0
```

V2 (`packages/v2`):

```bash
(cd packages/v2 && npm version 1.1.0 --no-git-tag-version)   # updates packages/v2 package.json + lock
# edit packages/v2/CHANGELOG.md
git commit -am "chore(release): opencode-dynamic-custom-providers-v2 1.1.0"
# PR, CI, merge, then:
git tag -a v2-plugin-v1.1.0 -m "opencode-dynamic-custom-providers-v2 1.1.0" <merge-commit>
git push origin v2-plugin-v1.1.0
```

Prereleases use a SemVer prerelease version and publish to `next`, never `latest`:
`npm version 1.2.0-beta.1 --no-git-tag-version` → tag `v2-plugin-v1.2.0-beta.1`. Install with
`npm install opencode-dynamic-custom-providers-v2@next`.

Before tagging, the manual CI run (`Actions → CI → Run workflow`, `release_tag` =
`v2-plugin-v1.1.0`) checks the planned tag without publishing. Approve the `npm-release-v*`
deployment when the `verify` job is green.

## Failure and retry

- **`verify` fails** (bad tag, version mismatch, not on `main`, test/pack/boundary failure,
  `latest` would go backwards): nothing was published and no credentials were issued. Delete the
  tag (`git push origin :refs/tags/<tag>`, `git tag -d <tag>`), fix on a branch, merge, and tag again.
  Re-tagging is safe only because nothing was published.
- **Approval rejected / environment misconfigured**: nothing published. Re-run the workflow after
  fixing the configuration, or delete the tag.
- **`publish-*` fails** (e.g. `ENEEDAUTH`: trusted publisher fields, allowed actions, environment
  name or expiry; registry error or timeout): use *Re-run failed jobs*. It republishes the same
  uploaded tarball (artifact retention 30 days) after re-checking the registry:
  - npm already has that version with identical bytes (the earlier attempt reached npm): success,
    nothing published, dist-tags untouched;
  - npm has it with different bytes: fails;
  - a newer stable version of the track was released in the meantime (current `latest` is equal
    or higher): fails, nothing published. The older version can no longer become `latest`; release
    a new version above `latest` instead. There is no override in the workflow;
  - the registry is unreachable or returns an unexpected response: fails, nothing published; re-run
    again later. Right after a publish the cached packument can lag the dist-tags for a few minutes,
    which can also fail closed this way.
- A retried *prerelease* still publishes to `next` without a `next` ordering check: do not re-run a
  failed prerelease job after a newer prerelease of the same track has shipped.
- **Published versions are immutable.** npm never accepts the same `name@version` twice, even after
  `npm unpublish`. A bad release is fixed by a new version (and `npm deprecate` of the bad one, by
  the owner). Never delete or move a tag that already produced a published version.

## V2 host-load UAT (before a V2 release)

Beyond CI, load the exact tarball in the targeted host: in an isolated HOME, reference it as
`"plugins": ["file:/abs/path.tgz"]` and run `opencode serve` (`@opencode/cli` of the targeted
version); `GET /api/plugin` must show `opencode-dynamic-custom-providers-v2` `active` with `server`,
`tui`, `rpc` features, and the TUI `/plugins` dialog must not list a failed TUI plugin.

## Retargeting a new OpenCode V2 release

The V2 plugin API is pre-1.0 in practice. To target a newer release, bump the pinned
`@opencode/plugin` dev dependency and `peerDependencies`, re-run the type check, the V2 tests, and
the host-load UAT above. Known 2.0.21 host behaviours the code depends on are commented in
`src/v2/` (fold order independence, no JSON Schema `pattern`, keymap layers from a mounted slot).
