import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { DisplayStyle } from "./discovery.js"
import type { ProviderConfig } from "./server.js"
import { reloadAllProviders, addProvider, validateAddProviderParams } from "./commands.js"

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

        const result = await reloadAllProviders(providers)

        if (result.providerCount === 0) {
          api.ui.toast({ message: "No dynamic providers configured.", variant: "warning" })
          return
        }

        api.ui.toast({
          message: `Reloading models from ${result.providerCount} provider(s)...`,
          variant: "info",
        })

        for (const w of result.warnings) {
          api.ui.toast({ message: w, variant: "warning" })
        }
        for (const e of result.errors) {
          api.ui.toast({ message: e, variant: "error" })
        }

        if (result.totalModels > 0) {
          await api.client.config.update({ config: { provider: providers } as never })
        }

        if (result.failures === 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            variant: "success",
          })
        } else if (result.totalModels > 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s). Check provider URLs/keys.`,
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

        const { data: config } = await api.client.config.get()
        const providers = (config?.provider as Record<string, ProviderConfig>) ?? {}

        let overwrite = false
        if (providers[providerId]) {
          overwrite = await showConfirm(
            api,
            "Provider already exists",
            `A provider with ID '${providerId}' already exists. Overwrite it?`,
          )
          if (!overwrite) return
        }

        const rawBaseURL = await showPrompt(api, "Base URL", "https://api.example.com/v1")
        if (!rawBaseURL) return

        const baseURL = rawBaseURL.trim().replace(/\/+$/, "")

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

        const params = { providerId, baseURL, apiKey, displayStyle, overwrite }
        const validationError = validateAddProviderParams(params, providers)
        if (validationError) {
          api.ui.toast({ message: validationError, variant: "error" })
          return
        }

        api.ui.toast({ message: `Discovering models from ${baseURL}...`, variant: "info" })

        const result = await addProvider(params)

        if (!result.success || !result.providerEntry) {
          api.ui.toast({ message: result.message, variant: "warning" })
          return
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
            result.providerEntry.options!.apiKey = apiKey
          }
        }

        providers[providerId] = result.providerEntry
        await api.client.config.update({ config: { provider: providers } as never })

        api.ui.toast({ message: result.message, variant: "success" })
      },
    },
  ])
}

export default { id, tui }
