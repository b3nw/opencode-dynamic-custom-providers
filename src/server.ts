import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { discoverAndEnrich, clearModelsDevCache, type DisplayStyle } from "./discovery.js"
import { isValidUrl, sanitizeErrorMessage } from "./security.js"

export const id = "opencode-dynamic-custom-providers"

export interface ProviderConfig {
  name?: string
  npm?: string
  api?: string
  dynamic?: boolean
  displayStyle?: DisplayStyle
  options?: {
    baseURL?: string
    apiKey?: string
    [key: string]: unknown
  }
  models?: Record<string, unknown>
  [key: string]: unknown
}

interface OpenCodeConfig {
  provider?: Record<string, ProviderConfig>
  [key: string]: unknown
}

function shouldDiscover(provider: ProviderConfig): boolean {
  const baseURL = provider.options?.baseURL
  if (!baseURL || !isValidUrl(baseURL)) return false
  if (provider.dynamic === true) return true
  const models = provider.models
  return !models || Object.keys(models).length === 0
}

export function getApiKey(provider: ProviderConfig, providerId: string): string | undefined {
  if (provider.options?.apiKey) return provider.options.apiKey
  const envKey = `OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`
  return process.env[envKey]
}

export const server: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      level: "info",
      message: "Plugin initialized",
      service: id,
    },
  })

  return {
    config: async (cfg: OpenCodeConfig) => {
      if (!cfg.provider) return

      for (const [providerId, providerConfig] of Object.entries(cfg.provider)) {
        if (!shouldDiscover(providerConfig)) continue

        const baseURL = providerConfig.options!.baseURL!
        const apiKey = getApiKey(providerConfig, providerId)

        try {
          await client.app.log({
            body: {
              level: "info",
              message: `Discovering models from ${providerId} at ${baseURL}`,
              service: id,
            },
          })

          const displayStyle = providerConfig.displayStyle ?? "slug"
          const models = await discoverAndEnrich(baseURL, apiKey, displayStyle)
          const count = Object.keys(models).length

          if (count === 0) {
            await client.app.log({
              body: {
                level: "warn",
                message: `No models discovered from ${providerId}`,
                service: id,
              },
            })
            continue
          }

          providerConfig.models = { ...(providerConfig.models as Record<string, unknown> ?? {}), ...models }
          providerConfig.npm = providerConfig.npm ?? "@ai-sdk/openai-compatible"
          providerConfig.api = providerConfig.api ?? baseURL

          await client.app.log({
            body: {
              level: "info",
              message: `Discovered ${count} model(s) from ${providerId}`,
              service: id,
            },
          })
        } catch (error) {
          await client.app.log({
            body: {
              level: "warn",
              message: `Failed to discover models from ${providerId}: ${sanitizeErrorMessage(error)}`,
              service: id,
            },
          })
        }
      }
    },

    tool: {
      "refresh-models": tool({
        description: "Clear the models.dev metadata cache and trigger re-discovery on next restart",
        args: {},
        async execute() {
          clearModelsDevCache()
          return "Model metadata cache cleared. Restart OpenCode to re-discover models from all dynamic providers."
        },
      }),
    },
  }
}

export default { id, server }
