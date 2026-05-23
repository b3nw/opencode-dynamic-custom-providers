# OpenCode Dynamic Custom Providers

This plugin extends OpenCode with dynamic model discovery for OpenAI-compatible providers, enriched with metadata from [models.dev](https://models.dev).

## Features

### 1. Automatic Model Discovery at Startup
The server plugin's `config` hook discovers models from any provider with a `baseURL` on every OpenCode startup. Models are always up-to-date without manual intervention.

### 2. models.dev Metadata Enrichment
Discovered models are cross-referenced against the [models.dev](https://models.dev) catalog (the same source OpenCode uses natively) to enrich them with accurate context windows, output limits, costs, capabilities (tool calling, reasoning, temperature), and input/output modalities.

### 3. `/add-provider` Slash Command
A TUI slash command for interactively adding new providers:
- Prompts for Provider ID, Base URL, and API Key
- Validates inputs and checks for duplicates
- Discovers models to confirm the endpoint works before saving
- Writes `dynamic: true` so models are re-discovered on each startup

### 4. `/reload-models` Slash Command
A TUI slash command (also available as `/refresh-models`) that re-discovers models from all providers with a `baseURL` without restarting OpenCode. Clears the models.dev cache and updates the live config in one step.

### 5. `refresh-models` Agent Tool
An in-session tool the agent can call to clear the models.dev metadata cache. Restart OpenCode after to re-discover all models with fresh metadata.

## Installation

```bash
opencode plugin opencode-dynamic-custom-providers
```

### Alternative: Install from GitHub
```bash
opencode plugin git+ssh://git@github.com/b3nw/opencode-dynamic-custom-providers.git
```

### Alternative: Local Clone (for Development)
```bash
git clone https://github.com/b3nw/opencode-dynamic-custom-providers
opencode plugin ./opencode-dynamic-custom-providers
```

## Configuration

### Adding a Provider via TUI
Run `/add-provider` in the OpenCode TUI and follow the prompts. The provider will be added with `dynamic: true` so models are discovered automatically on each startup.

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

## Limitations
- **Startup latency**: Each dynamic provider adds a network request at startup (15s timeout per endpoint, plus models.dev fetch on first run)
- **models.dev coverage**: Models not in the models.dev catalog get sensible defaults (128k context window, 4096 output limit, text-only modalities)
- **Capabilities detection**: Endpoint-reported capabilities (`supported_parameters`, `capabilities`) are merged with models.dev data; neither source alone is complete for all proxies

## Development

```bash
git clone https://github.com/b3nw/opencode-dynamic-custom-providers
cd opencode-dynamic-custom-providers
npm install
npm run build
```
