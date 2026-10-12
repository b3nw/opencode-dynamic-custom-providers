# Changelog

All notable changes to `opencode-dynamic-custom-providers-v2` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-12

### Added
- OpenCode V2 plugin (`@opencode/plugin` 2.0.21 Promise API) with separate `./server`, `./tui` and `./rpc` entrypoints.
- Native provider/model transforms: discovered models are mapped to V2 `Model.Info` (capabilities, limits, cost tiers with cache pricing, release time, status) with models.dev enrichment.
- Startup and on-eligibility discovery with last-good inventory retention on outages/empty responses and stale-ID removal on successful refresh; no polling.
- `refresh-models` and `add-provider` agent tools and the `opencode-dynamic-custom-providers-v2` RPC service (`status`, `refresh`, `addProvider`).
- Integration auth: key + legacy `OPENCODE_LOCAL_<ID>_API_KEY` env methods, credential resolution for discovery, key storage via `integration.connect.key`.
- TUI `/add-provider` wizard and `/reload-models` (`/refresh-models`) commands over RPC.
- JSONC-safe, atomic persistence of `providers.<id>` into the project `opencode.json(c)`, locked on the real config path across aliases and processes, with conflict detection against other writers.

### Security
- Discovery authenticates with the credential OpenCode execution uses (active connection first, then `settings.apiKey`); discovered inventory is bound to its source (URL, package, integration) and connection and is dropped, not retained, when either changes.
- The `add-provider` agent tool adds new providers credential-free and only on already approved origins (configured dynamic providers or plugin option `agentOrigins`); updates of an existing provider on its same approved origin use that provider's active credential (what execution already sends there). Other requests return `approval_required` without network access or writes. Interactive RPC/TUI updates never move existing credentials to a new origin.
- Base URLs with user info, query strings or fragments are rejected before any request or write; only same-origin redirects are followed. The `/models` request always stays on the base URL's origin, including for authority-looking base paths such as `https://host//other.host/v1`.
- Diagnostics never include remote response bodies and redact every known secret in raw and encoded forms.
- Session-added providers stop being injected once OpenCode's config provides them and are retired when the config deletes or changes them.
- Explicit config models opt a provider out even when their IDs equal discovered ones (from any config layer, checked by a fold without the plugin's injections); `discover: true` still opts in.
- Adds and updates are bound to the provider state they started from: if the provider is deleted, edited, or taken over by config while discovery or the config lock is pending, the result is `conflict` and nothing is written; the file entry is re-checked inside the locked write, and the saved entry (exact URL and package) and OpenCode's folded source (the starting or the saved one) again after the final ownership fold, before models are applied or a key is stored; injections stay off until that decision, so a config takeover folded during the final file read (including explicit models with discovered IDs) also returns `conflict`.
- Config locks are never broken by age: only a provably dead owner on the same host and PID namespace (PID gone or reused, or an earlier boot) loses its lock; breakers serialize on an exclusive `<lock>.break` marker and remove only the exact dead record re-read under it (never renaming a live lock aside), and a marker left by a crash makes dead-owner recovery report `busy` for manual removal; holders re-verify lock ownership and the config symlink target immediately before committing.
- RPC/tool cancellation and plugin cleanup abort in-flight discovery, settle queued calls and prevent later writes, key storage and reloads.
