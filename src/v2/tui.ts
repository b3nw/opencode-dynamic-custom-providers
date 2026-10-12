import type { Plugin } from "@opencode/plugin/tui"
import { DynamicProvidersRpc, isAddProviderResult, isRefreshResult, type AddProviderResult, type RefreshResult } from "./rpc.js"

export const id = "opencode-dynamic-custom-providers-v2"

type Context = Plugin.Context

const PROVIDER_ID = /^[a-zA-Z0-9_-]+$/

class UnexpectedResult extends Error {
  constructor() {
    super("The server returned an unexpected response. Is the server plugin the same version?")
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  return String(error)
}

function rpc(ctx: Context) {
  const client = ctx.client.rpc(DynamicProvidersRpc)
  // Discovery, credentials and config writes all happen on the server for this location,
  // including for remote-attached TUIs. The TUI never touches the local filesystem.
  const options = ctx.location ? { location: { directory: ctx.location.directory } } : undefined
  return {
    refresh: async (input: { providerID?: string }): Promise<RefreshResult> => {
      const result: unknown = await client.refresh(input, options)
      if (!isRefreshResult(result)) throw new UnexpectedResult()
      return result
    },
    addProvider: async (input: { providerID: string; baseURL: string; apiKey?: string; overwrite?: boolean }): Promise<AddProviderResult> => {
      const result: unknown = await client.addProvider(input, options)
      if (!isAddProviderResult(result)) throw new UnexpectedResult()
      return result
    },
  }
}

export async function runReload(ctx: Context): Promise<void> {
  ctx.ui.toast.show({ message: "Reloading models from dynamic providers...", variant: "info" })
  let result: RefreshResult
  try {
    result = await rpc(ctx).refresh({})
  } catch (error) {
    ctx.ui.toast.show({ title: "Reload failed", message: errorMessage(error), variant: "error" })
    return
  }
  if (result.cancelled) {
    ctx.ui.toast.show({ message: result.errors.join("\n"), variant: "warning" })
    return
  }
  if (!result.providerCount && !result.errors.length) {
    ctx.ui.toast.show({
      message: "No dynamic providers configured. Use /add-provider first.",
      variant: "warning",
    })
    return
  }
  const failures = result.failures
  const lines = [
    failures === 0
      ? `Reloaded ${result.totalModels} model(s) from ${result.updatedProviderIds.length} provider(s).`
      : `Reloaded ${result.totalModels} model(s) with ${failures} failure(s).`,
    ...result.warnings,
    ...result.errors,
  ]
  ctx.ui.toast.show({
    message: lines.join("\n"),
    variant: failures > 0 ? "warning" : "success",
    duration: failures > 0 ? 8000 : 4000,
  })
}

export async function runAddProvider(ctx: Context): Promise<void> {
  const cancelled = () => ctx.ui.toast.show({ message: "Add provider cancelled.", variant: "info" })

  const rawID = await ctx.ui.dialog.prompt({
    title: "Provider ID",
    description: "Alphanumeric, hyphens or underscores",
    placeholder: "my-proxy",
  })
  if (rawID === undefined) return cancelled()
  const providerID = rawID.trim()
  if (!PROVIDER_ID.test(providerID)) {
    ctx.ui.toast.show({ message: "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only.", variant: "error" })
    return
  }

  const rawURL = await ctx.ui.dialog.prompt({
    title: "Base URL",
    description: "OpenAI-compatible endpoint, e.g. https://api.example.com/v1",
    placeholder: "https://api.example.com/v1",
  })
  if (rawURL === undefined) return cancelled()
  const baseURL = rawURL.trim()
  if (!/^https?:\/\//i.test(baseURL)) {
    ctx.ui.toast.show({ message: "Invalid Base URL. Please enter a full URL (including https://).", variant: "error" })
    return
  }

  // OpenCode 2.0.21's dialog.prompt has no masking option: say so before the key is typed.
  const rawKey = await ctx.ui.dialog.prompt({
    title: "API Key (optional) - NOT masked, visible as you type",
    description:
      "Warning: this field shows the key in plain text on screen. Leave empty to skip and use /connect or an " +
      "environment variable instead. A key entered here is stored with OpenCode credentials on the server, never in config.",
    placeholder: "leave empty for none",
  })
  if (rawKey === undefined) return cancelled()
  const apiKey = rawKey.trim() || undefined

  ctx.ui.toast.show({ message: `Discovering models from ${providerID}...`, variant: "info" })
  let result: AddProviderResult
  try {
    const input = { providerID, baseURL, ...(apiKey ? { apiKey } : {}) }
    result = await rpc(ctx).addProvider(input)
    if (!result.ok && result.code === "duplicate") {
      const overwrite = await ctx.ui.dialog.confirm({
        title: "Provider exists",
        message: `A provider with ID '${providerID}' already exists. Update its base URL?`,
        label: { confirm: "Update", cancel: "Cancel" },
      })
      if (overwrite !== true) return cancelled()
      result = await rpc(ctx).addProvider({ ...input, overwrite: true })
    }
  } catch (error) {
    ctx.ui.toast.show({ title: "Add provider failed", message: errorMessage(error), variant: "error" })
    return
  }

  if (!result.ok) {
    ctx.ui.toast.show({ title: "Add provider failed", message: result.message, variant: "error", duration: 8000 })
    return
  }
  ctx.ui.toast.show({
    message: [result.message, ...result.warnings].join("\n"),
    variant: result.warnings.length ? "warning" : "success",
    duration: 6000,
  })
}

function commands(ctx: Context) {
  return [
    {
      id: "dynamic-providers.add",
      title: "Add OpenAI-compatible provider",
      description: "Discover models from an OpenAI-compatible endpoint and save it to the project config",
      group: "Providers",
      palette: true as const,
      slash: { name: "add-provider" },
      run: () => runAddProvider(ctx),
    },
    {
      id: "dynamic-providers.reload",
      title: "Reload dynamic provider models",
      description: "Re-discover models from all dynamic providers without restarting",
      group: "Providers",
      palette: true as const,
      slash: { name: "reload-models", aliases: ["refresh-models"] },
      run: () => runReload(ctx),
    },
  ]
}

const setup: Plugin.Definition["setup"] = (ctx) => {
  // OpenCode 2.0.21 requires keymap layers to be created by a mounted component
  // ("Keymap.Provider is missing" when called from setup). Mount a render-only claim
  // on the app slot, as the built-in TUI plugins do; it renders nothing.
  const release = ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({ mode: "global", commands: commands(ctx) }))
      return null
    },
  })
  return () => release()
}

const plugin: Plugin.Definition = { id, setup }

export default plugin
