# opencode-dynamic-custom-providers-v2

Dynamic model discovery for OpenAI-compatible providers in **OpenCode V2**, enriched with
[models.dev](https://models.dev) metadata. This is the V2 companion of
[`opencode-dynamic-custom-providers`](https://github.com/b3nw/opencode-dynamic-custom-providers#readme), which keeps serving OpenCode V1.

> Status: `1.0.x`, built and tested against the released `@opencode/plugin@2.0.21` /
> `@opencode/cli@2.0.21`. The V2 plugin API is still evolving; pin this package.

## Which package do I need?

| OpenCode | Package | Plugin config key | Provider config | Install |
|---|---|---|---|---|
| V1 (`>=1.14`) | `opencode-dynamic-custom-providers` `2.x` | `"plugin": [...]` | `provider.<id>.options.baseURL` | `opencode plugin opencode-dynamic-custom-providers` |
| V2 (`2.0.21`) | `opencode-dynamic-custom-providers-v2` `1.0.x` | `"plugins": [...]` | `providers.<id>.settings.baseURL` | add to `plugins` (below) or `opencode plugin add opencode-dynamic-custom-providers-v2` |

The two packages are independent; install exactly one per OpenCode installation. Do not
configure `opencode-dynamic-custom-providers` (or a subpath of it) in OpenCode V2: its default
export is a V1 `{ id, server }` plugin, which the V2 loader rejects. Their plugin IDs differ
(`opencode-dynamic-custom-providers` vs `opencode-dynamic-custom-providers-v2`), so an accidental
double install cannot register the same ID twice.

## Install

Project or global `opencode.json(c)`:

```jsonc
{
  "plugins": [
    "opencode-dynamic-custom-providers-v2@1.0.0"
    // or with options:
    // { "package": "opencode-dynamic-custom-providers-v2@1.0.0", "options": { "displayStyle": "name" } }
  ]
}
```

OpenCode installs the package itself (production dependencies only, install scripts disabled).
The only runtime dependency is `jsonc-parser`.

## Configure a provider

Any provider with an OpenAI-compatible package, a `settings.baseURL` and **no explicit
`models`** is discovered automatically:

```jsonc
{
  "providers": {
    "my-proxy": {
      "name": "My Proxy",
      "package": "@opencode/ai/providers/openai-compatible", // optional; set when empty
      "settings": { "baseURL": "https://api.proxy.example/v1" }
    }
  }
}
```

Eligibility rules (evaluated after every provider transform, including OpenCode's own config):

- `settings.baseURL` is a valid `http(s)` URL;
- `package` is empty, `@opencode/ai/providers/openai-compatible`, `@ai-sdk/openai-compatible` or
  `aisdk:@ai-sdk/openai-compatible` (other packages, e.g. Anthropic-compatible, are skipped);
- the provider has no explicit/catalog models, and is not one with native OpenCode discovery
  (`ollama`, `lmstudio`, `vllm`, `llama.cpp`) — unless explicitly opted in (below).

Explicit models count from every config layer OpenCode merges, including models whose IDs equal
ones this plugin discovered (e.g. you pin `models.beta` to rename it): the provider is then yours
and its discovered inventory is retired. Because the merged result of config and the plugin's
own injection cannot be told apart by model ID, the plugin re-checks ownership by folding once
**without** its injections to see what config alone defines, then restoring them. It does so after
every config reload OpenCode folds, on every `config.updated` event (and once more a second later,
in case OpenCode's reload interleaved with one of the plugin's own reloads), and at the start of
every explicit refresh. Between those two reloads (a few milliseconds) managed models are briefly
absent from OpenCode's model lists.

### Plugin options

```jsonc
{
  "plugins": [{
    "package": "opencode-dynamic-custom-providers-v2@1.0.0",
    "options": {
      "displayStyle": "slug",                 // "slug" (model ID, default) or "name" (friendly name)
      "providers": {
        "pinned-proxy": { "discover": true },  // opt in despite explicit models / native provider
        "other": { "discover": false },        // never discover this provider
        "named": { "displayStyle": "name" }
      },
      // Extra origins the agent `add-provider` tool may probe (see Security model). Exact
      // origins only: scheme://host[:port], no path, query or credentials.
      "agentOrigins": ["http://127.0.0.1:8080"]
    }
  }]
}
```

With `discover: true`, discovered models are added **alongside** explicit `models`. Explicit
model entries always win: OpenCode applies config model overrides (name, limits, capabilities,
`disabled`, …) after this plugin, so you can correct or hide any discovered model.

### Credentials

Discovery authenticates with **the same credential OpenCode 2.0.21 uses to run the provider's
models**, so the model list always belongs to the account that will serve it:

1. the integration's active connection — the newest stored credential (`/connect`,
   `opencode auth login`, or the key entered in the TUI `/add-provider` wizard), otherwise an env
   method whose variable is set, such as the legacy `OPENCODE_LOCAL_<ID>_API_KEY`
   (upper-cased, non-alphanumerics → `_`);
2. only when there is no active connection: `providers.<id>.settings.apiKey`.

OAuth connections are rejected for discovery (the provider then shows no discovered models)
rather than falling back to a different credential. For every managed provider the plugin
registers a key method and (unless your config already defines `env`) an env method for
`OPENCODE_LOCAL_<ID>_API_KEY`.

Discovered models are bound to the connection that produced them. When OpenCode reports a
credential change (`credential.updated`/`credential.switched`), or a refresh resolves a different
connection, the previous connection's models are removed and the provider is re-discovered;
they are never kept for a different account, even if the new discovery fails.

## Commands, tools and RPC

| Surface | Name | What it does |
|---|---|---|
| TUI | `/add-provider` (palette: "Add OpenAI-compatible provider") | Wizard: ID → base URL → optional API key; discovers first, then saves. Duplicate IDs ask before updating the base URL. |
| TUI | `/reload-models` (alias `/refresh-models`) | Re-discovers every dynamic provider. |
| Agent tool | `refresh-models` | Same as `/reload-models`; optional `providerID`. |
| Agent tool | `add-provider` | Restricted add on already approved origins (see Security model): new-provider adds are credential-free; updates of an existing provider on its same approved origin use its active credential. Anything else returns `approval_required` without contacting the endpoint. |
| RPC | `opencode-dynamic-custom-providers-v2` → `status`, `refresh`, `addProvider` | Shared server contract used by the TUI (exported from `opencode-dynamic-custom-providers-v2/rpc`). |

In OpenCode 2.0.21 agent tools from plugins are exposed through Code Mode
(`tools["refresh-models"]({})` inside `execute`), not as top-level function tools.

All discovery, credential storage and config writes happen on the **server** for the TUI's
location; the TUI never touches the local filesystem (important for remote-attached TUIs).

## Security model

The two ways to add a provider have different trust:

| | TUI wizard / RPC `addProvider` (interactive user) | Agent tool `add-provider` (model input, may be prompt-injected) |
|---|---|---|
| Endpoint | any `http(s)` URL the user types, including loopback/private hosts | only an origin already configured for a dynamic provider, or listed in plugin option `agentOrigins` |
| New provider ID | key typed in the wizard; otherwise the credential execution would use for that ID (e.g. its own `OPENCODE_LOCAL_<ID>_API_KEY`) | never any credential; refused (`approval_required`) if a stored or env credential already exists for the ID |
| Existing provider, same origin | the provider's active credential (no need to re-enter the key) | the provider's active credential (already sent to that origin by execution) |
| Existing provider, new origin | existing credentials are **not** sent to the new origin: re-enter the key (else `approval_required` when a credential exists) | refused (`approval_required`) |
| API key input | stored with OpenCode credentials, never in config | not accepted |

Refusals happen before any network request or config write. Other rules, for every caller:

- **Base URLs** added through the plugin must not contain user info, a query string or a
  fragment (query parameters often carry keys and would be saved to config, which is often
  committed). Put keys in the credential store. Query parameters you write into your own config
  are passed to discovery as configured but never shown in status output.
- **Redirects**: only same-origin redirects are followed (at most 3, credential kept). A redirect
  to another origin fails without requesting it; update the base URL instead.
- **Diagnostics** never include remote response bodies — only fixed messages such as
  `HTTP 401 Unauthorized`, `connection refused` or `request timed out` — and are redacted for
  every secret the operation knew (raw, trimmed, case-insensitive, URL-, JSON- and
  base64-encoded). Model IDs/names that echo a known secret are dropped.
- `refresh-models` (tool and TUI) only contacts configured providers' endpoints.

OpenCode itself sends a provider's active credential to whatever `settings.baseURL` your config
contains; the plugin cannot change that. Review base URL changes in config like any other
credential-bearing setting.

## Refresh semantics

- One discovery per eligible provider when the plugin starts, and once more whenever a provider
  newly becomes eligible or its source changes — base URL, package, integration, or the active
  connection (see Credentials). There is **no polling**.
- A successful, non-empty refresh replaces the provider's discovered inventory: removed model IDs
  disappear, new ones appear.
- Failed or empty refreshes keep the last good inventory **only for the same source and
  connection**, and report a warning/error. Inventory from an old URL, package or account is
  dropped instead, and `status` stops listing providers that left the config.
- Discovered inventory is runtime-only and is not persisted; it is rebuilt at startup.
- Cancelling an RPC call or tool call, or unloading the plugin, aborts in-flight discovery; queued
  calls settle as `cancelled`; no further write, key storage or host reload/list is started
  afterwards. OpenCode's host calls (`provider.reload`, `model.reload`, …) take no abort signal, so a
  host call already issued when cancellation arrives runs to completion and cannot be undone; the
  plugin checks cancellation after every awaited host call and starts nothing further. If
  cancellation arrives after the config file was already written, the result says so
  (`code: "cancelled"` with the saved path) and the API key is not stored.
- An add/update is decided against the provider as it was when the call started (config entry,
  OpenCode's folded source, eligibility, session addition). If, while discovery or the config lock
  is pending, the provider is deleted, its URL/package/fields edited, or config takes it over
  (explicit models), the call returns `code: "conflict"` and writes nothing — it never resurrects a
  deleted provider or overwrites your edit. The config entry is compared again inside the locked
  write; after saving, the saved entry and OpenCode's state are checked again before models are
  applied and before an API key is stored (a change in between returns `conflict`; the saved entry
  stays as written). The last check runs right after the post-save ownership fold: the project
  file must still hold exactly the saved URL and package, and OpenCode's folded source must be
  either the one the update started from (config not reloaded yet) or the saved one. This plugin's
  models stay out of OpenCode's fold until that decision, so a config change OpenCode folds during
  the final file read (even explicit models with discovered IDs) is seen before the key is stored.

## What `/add-provider` writes

Only `providers.<id>` in the location's project config — `opencode.jsonc` if present, else
`opencode.json`, else a new `opencode.jsonc`:

```jsonc
"my-proxy": { "name": "…", "package": "@opencode/ai/providers/openai-compatible", "settings": { "baseURL": "…" } }
```

Comments, unknown keys and other providers are preserved (lines touched by the edit may be
re-indented, the same `jsonc-parser` edit mechanism OpenCode uses for its own config). Malformed
files are refused, never replaced. Updating an existing provider only changes
`settings.baseURL` (and `name`/`package` when provided/missing); explicit `models`, `headers`,
`env` etc. are kept. API keys are stored with OpenCode credentials (`integration.connect.key`),
never in config.

Writes are transactional against other writers:

- The target is resolved to its real path (symlinked configs and directory aliases are followed),
  so every alias of one file shares one lock.
- Instances of this plugin in other processes coordinate through an exclusive lock file next to
  the real config (`.opencode.jsonc.lock` / `.opencode.json.lock`, created atomically with its owner
  record and removed afterwards). A lock is broken only when its owner is provably dead on the same
  host and in the same PID namespace: its PID no longer exists, the PID now belongs to a process
  with another start time (Linux), or the host has rebooted since (Linux boot ID). A live owner —
  including another holder in the same process — is never displaced, however old its lock: callers
  wait up to 10 s and then get `busy` naming the lock file. Locks from another host or PID
  namespace (e.g. containers sharing a hostname), or unreadable ones, are never broken
  automatically — remove the file by hand if no writer is running. Breaking is itself exclusive:
  a breaker creates `<lock>.break`, re-reads the lock under it and removes it only if it is still
  the dead owner's record, so a live lock is never removed, even transiently. That marker is never
  broken automatically: if a crash leaves it behind, recovery from a dead owner stops with `busy`
  naming both files until you remove them by hand (it does not block writers while the lock
  itself is free). Release removes only a lock carrying the holder's token. Immediately before
  committing, the holder re-verifies that it still owns the lock (else `busy`, nothing written).
- Just before committing, the config path is resolved again: if the project config was retargeted
  (symlink changed) or a `.jsonc`/`.json` file appeared or vanished, the edit is re-applied to the
  file now selected; the previously resolved file is never written.
- Writers that do not take the lock (your editor, OpenCode itself) are detected if they change the
  file before the final re-read just before the atomic rename: the edit is then re-applied to the
  new content (up to 5 attempts, then a `conflict` error with nothing overwritten). A new file is
  created with `link(2)` so a concurrently created config is never clobbered.
- **Accepted residual race:** a non-cooperating writer that changes the file, or retargets its
  symlink, in the window between that final re-read and `rename(2)` loses its change (or the
  write lands in the previously selected file). POSIX has no compare-and-swap rename, so this
  window cannot be closed against writers that do not take the lock; it is explicitly out of
  scope. Writers that take the lock are fully serialized. Locking is host-local; network
  filesystems and writers on other hosts are not covered.
- The replacement keeps the file mode; ownership is copied where the process is permitted to
  (not verified by tests). Temp files are removed on every failure path.

A provider that is **new** to OpenCode is usable immediately: the plugin injects it until
OpenCode's own config reload provides it, then stops (it checks this by folding once without its
injection). If you delete it from config, change its URL/package, or give it explicit models
before or after that, the injection and its models are retired. An **existing** provider switches
to the new URL when OpenCode reloads the config (2.0.21 does so automatically on file change);
the models discovered by the update are applied at that moment.

## Migrating from the V1 package

| V1 (`opencode-dynamic-custom-providers`) | V2 (`opencode-dynamic-custom-providers-v2`) |
|---|---|
| `"plugin": ["opencode-dynamic-custom-providers"]` | `"plugins": ["opencode-dynamic-custom-providers-v2@1.0.0"]` |
| `provider.<id>` | `providers.<id>` |
| `npm: "@ai-sdk/openai-compatible"` | `package: "@opencode/ai/providers/openai-compatible"` (or omit) |
| `options.baseURL` | `settings.baseURL` |
| `options.apiKey` / `auth.set` | `/connect`, TUI wizard, or `OPENCODE_LOCAL_<ID>_API_KEY` (`settings.apiKey` still works) |
| `dynamic: true` | plugin option `providers.<id>.discover: true` |
| `displayStyle` on the provider | plugin option `displayStyle` / `providers.<id>.displayStyle` |
| writes models into `config.json` | never persists discovered models |

No automatic conversion is performed.

## Limitations

- TUI dialog prompts in 2.0.21 have no masked input: the optional API key is visible while typed,
  and the wizard says so before you type. Leave it empty to skip and configure the key another
  way (e.g. an environment variable); this package does not verify how other OpenCode UIs display
  keys.
- `refresh-models`/`/reload-models` clear this package's models.dev cache
  (`$XDG_CACHE_HOME` or `~/.cache`, `opencode-dynamic-providers-v2/models-dev.json`) and re-fetch
  `https://models.dev/api.json`.
- Only `GET <baseURL>/models` OpenAI-style listings are supported; OAuth connections are not used
  for discovery.
- Credential change tracking relies on OpenCode's credential events; if they are not delivered,
  the next refresh still re-resolves the connection and drops the old account's models.

## Development

The source lives in the repository root (`src/v2/`, self-contained: the V1 `src/discovery.ts` and
`src/security.ts` are not used by V2); this directory holds the package manifest, its own
lockfile and TypeScript config.

```bash
cd packages/v2
npm ci
npm test         # tsc build + node --test ../../tests/v2/*.test.mjs
npm pack         # prepack builds dist/
```

Releases are tag-driven (`v2-plugin-v<version>`); see
[RELEASING.md](https://github.com/b3nw/opencode-dynamic-custom-providers/blob/main/RELEASING.md).
