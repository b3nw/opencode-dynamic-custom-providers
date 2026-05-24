import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { discoverAndEnrich, type DisplayStyle } from "./discovery.js"
import { isValidUrl, sanitizeErrorMessage, sanitizeUrl } from "./security.js"
import { reloadAllProviders, addProvider, validateAddProviderParams } from "./commands.js"

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
              message: `Discovering models from ${providerId} at ${sanitizeUrl(baseURL)}`,
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
        description:
          "Re-discover models from all dynamic providers and update the live config. " +
          "Clears the models.dev metadata cache, fetches /models from every provider " +
          "with a baseURL, enriches them, and persists the updated config.",
        args: {},
        async execute() {
          const { data: config } = await client.config.get()
          const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

          const result = await reloadAllProviders(providers)

          if (result.providerCount === 0) {
            return "No dynamic providers configured. Add a provider with a baseURL first."
          }

          if (result.totalModels > 0) {
            await client.config.update({
              body: { provider: providers } as never,
            })
          }

          const lines: string[] = []
          if (result.failures === 0) {
            lines.push(
              `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            )
          } else {
            lines.push(
              `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s).`,
            )
          }
          for (const w of result.warnings) lines.push(`Warning: ${w}`)
          for (const e of result.errors) lines.push(`Error: ${e}`)

          return lines.join("\n")
        },
      }),

      "add-provider": tool({
        description:
          "Add a new OpenAI-compatible provider with dynamic model discovery. " +
          "Validates the endpoint, discovers available models, enriches them with " +
          "models.dev metadata, and persists the provider to the config.",
        args: {
          providerId: tool.schema
            .string()
            .describe("Unique provider ID (alphanumeric, hyphens, underscores only)"),
          baseURL: tool.schema
            .string()
            .describe("Base URL of the OpenAI-compatible API endpoint (e.g. https://api.example.com/v1)"),
          apiKey: tool.schema
            .string()
            .optional()
            .describe("API key for authentication (optional)"),
          displayStyle: tool.schema
            .enum(["slug", "name"])
            .optional()
            .describe("How to display model names: 'slug' for full ID (default), 'name' for friendly name"),
          overwrite: tool.schema
            .boolean()
            .optional()
            .describe("Overwrite if a provider with this ID already exists (default: false)"),
        },
        async execute(args) {
          const { data: config } = await client.config.get()
          const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

          const validationError = validateAddProviderParams(args, providers)
          if (validationError) return validationError

          const result = await addProvider(args)
          if (!result.success || !result.providerEntry) return result.message

          if (args.apiKey) {
            let storedInAuthStore = false
            try {
              await client.auth.set({
                path: { id: args.providerId },
                body: { type: "api", key: args.apiKey },
              })
              storedInAuthStore = true
            } catch {
              // Auth store unavailable — fall back to config
            }
            if (!storedInAuthStore) {
              result.providerEntry.options!.apiKey = args.apiKey
            }
          }

          providers[args.providerId] = result.providerEntry
          await client.config.update({
            body: { provider: providers } as never,
          })

          return result.message
        },
      }),
    },
  }
}

export default { id, server }
