import type { Plugin } from "@opencode/plugin"
import { parseOptions } from "./options.js"
import { DynamicProvidersRpc } from "./rpc.js"
import { createService, legacyEnvName, type AddProviderInput, type RefreshResult } from "./service.js"

export const id = "opencode-dynamic-custom-providers-v2"

export { DynamicProvidersRpc, RPC_ID } from "./rpc.js"
export type { AddProviderResult, ProviderStatus, RefreshResult } from "./rpc.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function parseAddProviderInput(raw: unknown, allowApiKey: boolean): AddProviderInput | string {
  if (!isRecord(raw)) return "Invalid input: expected an object."
  const providerID = optionalString(raw.providerID)?.trim()
  const baseURL = optionalString(raw.baseURL)?.trim()
  if (!providerID) return "Invalid input: providerID is required."
  if (!baseURL) return "Invalid input: baseURL is required."
  const apiKey = allowApiKey ? optionalString(raw.apiKey) : undefined
  return {
    providerID,
    baseURL,
    name: optionalString(raw.name),
    ...(apiKey ? { apiKey } : {}),
    overwrite: raw.overwrite === true,
  }
}

export function formatRefresh(result: RefreshResult): string {
  if (result.cancelled) return result.errors.join("\n")
  if (result.providerCount === 0 && result.errors.length === 0) {
    return "No dynamic providers configured. Add an OpenAI-compatible provider with settings.baseURL and no explicit models first."
  }
  const lines = [
    result.failures === 0
      ? `Reloaded ${result.totalModels} model(s) from ${result.updatedProviderIds.length} provider(s).`
      : `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s).`,
  ]
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`)
  for (const error of result.errors) lines.push(`Error: ${error}`)
  return lines.join("\n")
}

const setup: Plugin.Plugin["setup"] = async (ctx) => {
  const service = createService(ctx, parseOptions(ctx.options))

  await ctx.integration.transform((integrations) => service.transformIntegrations(integrations))
  await ctx.provider.transform((providers) => service.transformProviders(providers))
  await ctx.model.transform((models) => service.observeModels(models))

  await ctx.tool.transform((tools) => {
    tools.add({
      name: "refresh-models",
      description:
        "Re-discover models from every dynamic OpenAI-compatible provider and update the live model list. " +
        "Clears the models.dev metadata cache. Providers that fail or return no models keep their previous models.",
      input: {
        type: "object",
        properties: {
          providerID: { type: "string", description: "Refresh only this provider (optional)" },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const providerID = isRecord(input) ? optionalString(input.providerID) : undefined
        const result = await service.refresh({ providerID, clearCache: true }, { caller: "agent", signal: context?.signal })
        return { content: formatRefresh(result) }
      },
    })
    tools.add({
      name: "add-provider",
      description:
        "Add an OpenAI-compatible provider with dynamic model discovery to this project's opencode.json(c). " +
        "Validates the endpoint and discovers models before saving. Does not accept API keys. A new provider is " +
        "added credential-free, and only on an origin that is already configured for a dynamic provider (or listed " +
        "in the plugin option agentOrigins); updating an existing provider on its same approved origin uses that " +
        "provider's active credential, as OpenCode execution already does. An existing provider's origin cannot be " +
        "changed; anything else returns approval-required without contacting the endpoint. For other or " +
        "authenticated endpoints ask the user to run /add-provider in the TUI.",
      input: {
        type: "object",
        properties: {
          providerID: { type: "string", description: "Unique provider ID (alphanumeric, hyphens, underscores only)" },
          baseURL: { type: "string", description: "Base URL of the OpenAI-compatible API (e.g. https://api.example.com/v1)" },
          name: { type: "string", description: "Display name (optional)" },
          overwrite: { type: "boolean", description: "Update the base URL (same origin only) if the provider already exists (default: false)" },
        },
        required: ["providerID", "baseURL"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const parsed = parseAddProviderInput(input, false)
        if (typeof parsed === "string") return { content: parsed }
        const result = await service.addProvider(parsed, { caller: "agent", signal: context?.signal })
        if (!result.ok) {
          const hint =
            result.code === "discovery_failed" && !/run \/add-provider/.test(result.message)
              ? ` If the endpoint requires authentication, ask the user to run /add-provider in the TUI (or set ${legacyEnvName(parsed.providerID)} for the server and configure the provider).`
              : ""
          return { content: `${result.message}${hint}` }
        }
        return { content: [result.message, `Saved to ${result.configPath}.`, ...result.warnings].join("\n") }
      },
    })
  })

  // RPC callers are interactive clients (the TUI wizard), not the model.
  await ctx.rpc.register(DynamicProvidersRpc, {
    status: async (_input, context) => ({ providers: await service.settledStatus({ signal: context?.signal }) }),
    refresh: async (input, context) => {
      const providerID = isRecord(input) ? optionalString(input.providerID) : undefined
      return service.refresh({ providerID, clearCache: true }, { caller: "user", signal: context?.signal })
    },
    addProvider: async (input, context) => {
      const parsed = parseAddProviderInput(input, true)
      if (typeof parsed === "string") return { ok: false, code: "invalid", message: parsed }
      return service.addProvider(parsed, { caller: "user", signal: context?.signal })
    },
  })

  // One startup discovery, detached so plugin boot is not blocked on the network. No polling.
  service.start()

  return () => service.dispose()
}

const plugin: Plugin.Plugin = { id, setup }

export default plugin
