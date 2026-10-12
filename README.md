# OpenCode Dynamic Custom Providers

This plugin extends OpenCode with dynamic model discovery for OpenAI-compatible providers, enriched with metadata from [models.dev](https://models.dev).

> **OpenCode V2:** this package targets OpenCode V1. For OpenCode V2 (`2.0.21`) install
> [`opencode-dynamic-custom-providers-v2`](https://github.com/b3nw/opencode-dynamic-custom-providers/blob/main/packages/v2/README.md) instead:
>
> | OpenCode | Package | Config |
> |---|---|---|
> | V1 (`>=1.14`) | `opencode-dynamic-custom-providers` (this package) | `"plugin"`, `provider.<id>.options.baseURL` |
> | V2 (`2.0.21`) | `opencode-dynamic-custom-providers-v2` | `"plugins"`, `providers.<id>.settings.baseURL` |

## Features

### 1. Automatic Model Discovery at Startup
The server plugin's `config` hook discovers models from any provider with a `baseURL` on every OpenCode startup. Models are always up-to-date without manual intervention.

### 2. models.dev Metadata Enrichment
Discovered models are cross-referenced against the [models.dev](https://models.dev) catalog (the same source OpenCode uses natively) to enrich them with accurate context windows, output limits, costs, capabilities (tool calling, reasoning, temperature), and input/output modalities.

### 3. `/add-provider` Slash Command (TUI)
An interactive TUI wizard for adding new providers:
- Prompts for Provider ID, Base URL, and API Key
- Validates inputs and checks for duplicates
- Discovers models to confirm the endpoint works before saving
- Writes `dynamic: true` so models are re-discovered on each startup

### 4. `/reload-models` Slash Command (TUI)
A TUI slash command (also available as `/refresh-models`) that re-discovers models from all providers with a `baseURL` without restarting OpenCode. Clears the models.dev cache and updates the live config in one step.

### 5. `add-provider` Agent Tool (Web / Desktop / TUI)
A server-side tool the AI agent can call to add a new provider programmatically. Works in all interfaces (web, desktop, and TUI). Accepts provider ID, base URL, API key, and display style as arguments, validates the endpoint, discovers models, and persists the provider config.

### 6. `refresh-models` Agent Tool (Web / Desktop / TUI)
A server-side tool the AI agent can call to re-discover models from all dynamic providers and update the live config. Clears the models.dev metadata cache, fetches `/models` from every provider with a baseURL, enriches them, and persists the updated config. Works in all interfaces without restarting.

## Installation

Install exactly one track, matching your OpenCode version. The V1 and V2 plugins have different
package names and config keys (`"plugin"` vs `"plugins"`).

### OpenCode V1 (`>=1.14`): `opencode-dynamic-custom-providers`

```bash
opencode plugin opencode-dynamic-custom-providers
```

#### Alternative: Install from GitHub
```bash
opencode plugin git+ssh://git@github.com/b3nw/opencode-dynamic-custom-providers.git
```

#### Alternative: Local Clone (for Development)
```bash
git clone https://github.com/b3nw/opencode-dynamic-custom-providers
opencode plugin ./opencode-dynamic-custom-providers
```

The GitHub and local-clone commands above install the V1 plugin only. Do not use them for OpenCode V2.

### OpenCode V2 (`2.0.21`): `opencode-dynamic-custom-providers-v2`

Install the V2 plugin:

```bash
opencode plugin add opencode-dynamic-custom-providers-v2@1.0.0
```

or add it to the `plugins` array of `opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-dynamic-custom-providers-v2@1.0.0"]
}
```

#### Alternative: Local Clone (for Development)

```bash
git clone https://github.com/b3nw/opencode-dynamic-custom-providers
cd opencode-dynamic-custom-providers/packages/v2
npm ci --ignore-scripts
npm run build
```

Then point `plugins` at the built `dist/v2` directory using its absolute path (a directory, not a
file; OpenCode V2 loads `server.js`, `tui.js` and `rpc.js` from it):

```jsonc
{
  "plugins": ["file:///absolute/path/to/opencode-dynamic-custom-providers/packages/v2/dist/v2"]
}
```

See the [V2 README](https://github.com/b3nw/opencode-dynamic-custom-providers/blob/main/packages/v2/README.md) for V2 configuration (`providers.<id>.settings.baseURL`).

## Configuration

### Adding a Provider via TUI
Run `/add-provider` in the OpenCode TUI and follow the interactive prompts. The provider will be added with `dynamic: true` so models are discovered automatically on each startup.

### Adding a Provider via the Agent (Web / Desktop)
Ask the AI agent to add a provider. The agent will use the `add-provider` tool with the parameters you provide. For example: *"Add an OpenAI-compatible provider called my-proxy at https://api.proxy.com/v1 with API key sk-..."*

### Adding a Provider Manually
Add a provider to `opencode.json` with a `baseURL`. Models will be discovered automatically:

```json
{
  "provider": {
    "my-proxy": {
      "name": "My Proxy",
      "options": {
        "baseURL": "https://api.proxy.com/v1"
      }
    }
  }
}
```

For explicit opt-in, set `"dynamic": true`:

```json
{
  "provider": {
    "my-proxy": {
      "name": "My Proxy",
      "dynamic": true,
      "options": {
        "baseURL": "https://api.proxy.com/v1"
      }
    }
  }
}
```

### API Key Authentication

API keys can be set in three ways:

1. **Via the `/add-provider` TUI command** (stored securely via OpenCode's auth system)
2. **In config** under `options.apiKey`:
   ```json
   {
     "provider": {
       "my-proxy": {
         "options": {
           "baseURL": "https://api.proxy.com/v1",
           "apiKey": "sk-..."
         }
       }
     }
   }
   ```
3. **Via environment variable** using the pattern `OPENCODE_LOCAL_<PROVIDER_ID>_API_KEY`:
   ```bash
   export OPENCODE_LOCAL_MY_PROXY_API_KEY=sk-...
   ```

## How It Works

1. On startup, the server plugin's `config` hook iterates all providers with a `baseURL`
2. For each eligible provider (no models defined, or `dynamic: true`), it fetches `/v1/models`
3. Each discovered model ID is cross-referenced against the models.dev catalog
4. Matching models get enriched metadata (context window, costs, capabilities, modalities)
5. Enriched models are injected into the live config before OpenCode loads providers
6. The provider is set to use `@ai-sdk/openai-compatible` as the SDK package

## Discovery Trigger

A provider is eligible for discovery when it has `options.baseURL` and either:
- Has `dynamic: true` set in config, **or**
- Has no `models` key (or empty models) in config

Providers that already have models defined in config are left unchanged unless `dynamic: true` is set.

## Troubleshooting

### Built-in Providers Appear Alongside a Proxy

Some OpenAI-compatible proxies return model IDs that overlap with OpenCode's built-in provider namespaces. If OpenCode auto-displays built-in providers you do not intend to use, suppress them with the `disabled_providers` config key. After changing config, restart OpenCode so the provider list is rebuilt.

## Limitations
- **Startup latency**: Each dynamic provider adds a network request at startup (15s timeout per endpoint, plus models.dev fetch on first run)
- **models.dev coverage**: Models not in the models.dev catalog get sensible defaults (128k context window, 4096 output limit, text-only modalities)
- **Capabilities detection**: Endpoint-reported capabilities (`supported_parameters`, `capabilities`) are merged with models.dev data; neither source alone is complete for all proxies

## Development

```bash
git clone https://github.com/b3nw/opencode-dynamic-custom-providers
cd opencode-dynamic-custom-providers
npm ci
npm run build
```

CI and the tag-driven npm release process for both packages are described in [RELEASING.md](https://github.com/b3nw/opencode-dynamic-custom-providers/blob/main/RELEASING.md).
