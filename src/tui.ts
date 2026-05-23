import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { discoverAndEnrich, clearModelsDevCache, type DisplayStyle } from "./discovery.js"
import { isValidUrl, sanitizeErrorMessage } from "./security.js"
import { getApiKey, type ProviderConfig } from "./server.js"

export const id = "opencode-dynamic-custom-providers"

function showPrompt(api: TuiPluginApi, title: string, placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogPrompt({
          title,
          placeholder,
          onConfirm: (value: string) => resolve(value),
          onCancel: () => resolve(null),
        }),
      () => resolve(null),
    )
  })
}

function showConfirm(api: TuiPluginApi, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogConfirm({
          title,
          message,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      () => resolve(false),
    )
  })
}

function showSelect<V>(
  api: TuiPluginApi,
  title: string,
  options: Array<{ title: string; value: V; description?: string }>,
): Promise<V | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title,
          options: options.map((o) => ({
            ...o,
            onSelect: () => resolve(o.value),
          })),
        }),
      () => resolve(null),
    )
  })
}

export const tui: TuiPlugin = async (api: TuiPluginApi) => {
  api.command.register(() => [
    {
      title: "Reload Models",
      value: "reload-models",
      description: "Re-discover models from all dynamic providers without restarting",
      slash: {
        name: "reload-models",
        aliases: ["refresh-models"],
      },
      onSelect: async () => {
        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

        const dynamicProviders = Object.entries(providers).filter(
          ([, p]) => !!p.options?.baseURL && isValidUrl(p.options.baseURL),
        )

        if (dynamicProviders.length === 0) {
          api.ui.toast({ message: "No dynamic providers configured.", variant: "warning" })
          return
        }

        api.ui.toast({ message: `Reloading models from ${dynamicProviders.length} provider(s)...`, variant: "info" })

        clearModelsDevCache()

        let totalModels = 0
        let failures = 0

        for (const [providerId, providerConfig] of dynamicProviders) {
          const baseURL = providerConfig.options!.baseURL!
          const apiKey = getApiKey(providerConfig, providerId)
          const displayStyle: DisplayStyle = providerConfig.displayStyle ?? "slug"

          try {
            const models = await discoverAndEnrich(baseURL, apiKey, displayStyle)
            const count = Object.keys(models).length

            if (count > 0) {
              providerConfig.models = { ...(providerConfig.models ?? {}), ...models }
              totalModels += count
            } else if (providerConfig.models && Object.keys(providerConfig.models).length > 0) {
              api.ui.toast({
                message: `${providerId} returned 0 models (keeping previous models). Check endpoint status.`,
                variant: "warning",
              })
            }
          } catch (error) {
            failures++
            api.ui.toast({
              message: `Failed to reload ${providerId}: ${sanitizeErrorMessage(error)}`,
              variant: "error",
            })
          }
        }

        if (totalModels > 0) {
          await api.client.config.update({ config: { provider: providers as Record<string, any> } })
        }

        if (failures === 0) {
          api.ui.toast({
            message: `Reloaded ${totalModels} model(s) from ${dynamicProviders.length} provider(s).`,
            variant: "success",
          })
        } else if (totalModels > 0) {
          api.ui.toast({
            message: `Reloaded ${totalModels} model(s) with ${failures} failure(s). Check provider URLs/keys.`,
            variant: "warning",
          })
        }
      },
    },
    {
      title: "Add Provider",
      value: "add-provider",
      description: "Add a new OpenAI-compatible custom provider with dynamic model discovery",
      slash: {
        name: "add-provider",
      },
      onSelect: async () => {
        const rawProviderId = await showPrompt(api, "Provider ID", "e.g., my-proxy (alphanumeric only)")
        if (!rawProviderId) return

        const providerId = rawProviderId.trim()
        if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
          api.ui.toast({ message: "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only.", variant: "error" })
          return
        }

        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

        if (providers[providerId]) {
          const overwrite = await showConfirm(
            api,
            "Provider already exists",
            `A provider with ID '${providerId}' already exists. Overwrite it?`,
          )
          if (!overwrite) return
        }

        const rawBaseURL = await showPrompt(api, "Base URL", "https://api.example.com/v1")
        if (!rawBaseURL) return

        const baseURL = rawBaseURL.trim().replace(/\/+$/, "")
        if (!isValidUrl(baseURL)) {
          api.ui.toast({ message: "Invalid Base URL. Please enter a full URL (including https://).", variant: "error" })
          return
        }

        const rawApiKey = await showPrompt(api, "API Key (Optional)", "sk-...")
        const apiKey = rawApiKey?.trim() || undefined

        const displayStyle = await showSelect<DisplayStyle>(api, "Model Display Names", [
          {
            title: "Full Slug",
            value: "slug",
            description: "vertex/gemini-3.1-pro (best for proxies)",
          },
          {
            title: "Friendly Name",
            value: "name",
            description: "Gemini 3.1 Pro (may be ambiguous)",
          },
        ])
        if (!displayStyle) return

        api.ui.toast({ message: `Discovering models from ${baseURL}...`, variant: "info" })

        try {
          const models = await discoverAndEnrich(baseURL, apiKey, displayStyle)
          const modelCount = Object.keys(models).length

          if (modelCount === 0) {
            api.ui.toast({ message: "No models found at the given endpoint. Provider not added.", variant: "warning" })
            return
          }

          const providerEntry: ProviderConfig = {
            name: providerId,
            npm: "@ai-sdk/openai-compatible",
            api: baseURL,
            options: { baseURL },
            dynamic: true,
            displayStyle,
          }

          if (apiKey) {
            let storedInAuthStore = false
            try {
              await api.client.auth.set({
                providerID: providerId,
                auth: { type: "api", key: apiKey },
              })
              storedInAuthStore = true
            } catch {
              // Auth store unavailable — fall back to config file
            }
            if (!storedInAuthStore) {
              providerEntry.options!.apiKey = apiKey
            }
          }

          providers[providerId] = providerEntry
          await api.client.config.update({ config: { provider: providers as Record<string, any> } })

          api.ui.toast({
            message: `Provider '${providerId}' added (${modelCount} models discovered). Restart opencode to use it.`,
            variant: "success",
          })
        } catch (error) {
          api.ui.toast({
            message: `Failed to discover models: ${sanitizeErrorMessage(error)}`,
            variant: "error",
          })
        }
      },
    },
  ])
}

export default { id, tui }
