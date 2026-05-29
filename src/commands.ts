import { discoverAndEnrich, clearModelsDevCache, type DisplayStyle } from "./discovery.js"
import { isValidUrl, sanitizeErrorMessage } from "./security.js"
import { getApiKey, shouldDiscover, type ProviderConfig } from "./types.js"

export interface ReloadResult {
  totalModels: number
  failures: number
  providerCount: number
  warnings: string[]
  errors: string[]
}

interface ProviderReloadOutcome {
  providerId: string
  models: Record<string, unknown> | null
  warning?: string
  error?: string
}

async function reloadOneProvider(
  providerId: string,
  providerConfig: ProviderConfig,
): Promise<ProviderReloadOutcome> {
  const baseURL = providerConfig.options!.baseURL!
  const apiKey = getApiKey(providerConfig, providerId)
  const displayStyle: DisplayStyle = providerConfig.displayStyle ?? "slug"

  try {
    const models = await discoverAndEnrich(baseURL, apiKey, displayStyle)
    const count = Object.keys(models).length

    if (count > 0) {
      return { providerId, models }
    }

    if (providerConfig.models && Object.keys(providerConfig.models).length > 0) {
      return {
        providerId,
        models: null,
        warning: `${providerId} returned 0 models (keeping previous models). Check endpoint status.`,
      }
    }

    return { providerId, models: null }
  } catch (error) {
    return {
      providerId,
      models: null,
      error: `Failed to reload ${providerId}: ${sanitizeErrorMessage(error)}`,
    }
  }
}

export async function reloadAllProviders(
  providers: Record<string, ProviderConfig>,
): Promise<ReloadResult> {
  const dynamicProviders = Object.entries(providers).filter(
    ([, p]) => shouldDiscover(p),
  )

  const result: ReloadResult = {
    totalModels: 0,
    failures: 0,
    providerCount: dynamicProviders.length,
    warnings: [],
    errors: [],
  }

  if (dynamicProviders.length === 0) return result

  clearModelsDevCache()

  const outcomes = await Promise.allSettled(
    dynamicProviders.map(([id, cfg]) => reloadOneProvider(id, cfg)),
  )

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      result.failures++
      result.errors.push(`Unexpected error: ${sanitizeErrorMessage(outcome.reason)}`)
      continue
    }

    const { providerId, models, warning, error } = outcome.value

    if (error) {
      result.failures++
      result.errors.push(error)
    } else if (warning) {
      result.warnings.push(warning)
    }

    if (models) {
      const providerConfig = providers[providerId]
      providerConfig.models = models
      result.totalModels += Object.keys(models).length
    }
  }

  return result
}

export interface AddProviderParams {
  providerId: string
  baseURL: string
  apiKey?: string
  displayStyle?: DisplayStyle
  overwrite?: boolean
}

export interface AddProviderResult {
  success: boolean
  modelCount: number
  message: string
  providerEntry?: ProviderConfig
}

export function validateProviderId(providerId: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
    return "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only."
  }
  return null
}

export function validateAddProviderParams(
  params: AddProviderParams,
  existingProviders: Record<string, ProviderConfig>,
): string | null {
  const idError = validateProviderId(params.providerId)
  if (idError) return idError
  if (!isValidUrl(params.baseURL)) {
    return "Invalid Base URL. Please enter a full URL (including https://)."
  }
  if (existingProviders[params.providerId] && !params.overwrite) {
    return `A provider with ID '${params.providerId}' already exists. Set overwrite to true to replace it.`
  }
  return null
}

export async function addProvider(
  params: AddProviderParams,
): Promise<AddProviderResult> {
  const displayStyle = params.displayStyle ?? "slug"
  const baseURL = params.baseURL.trim().replace(/\/+$/, "")

  try {
    const models = await discoverAndEnrich(baseURL, params.apiKey, displayStyle)
    const modelCount = Object.keys(models).length

    if (modelCount === 0) {
      return {
        success: false,
        modelCount: 0,
        message: "No models found at the given endpoint. Provider not added.",
      }
    }

    const providerEntry: ProviderConfig = {
      name: params.providerId,
      npm: "@ai-sdk/openai-compatible",
      api: baseURL,
      options: { baseURL },
      dynamic: true,
      displayStyle,
      models,
    }

    return {
      success: true,
      modelCount,
      message: `Provider '${params.providerId}' added with ${modelCount} model(s).`,
      providerEntry,
    }
  } catch (error) {
    return {
      success: false,
      modelCount: 0,
      message: `Failed to discover models: ${sanitizeErrorMessage(error)}`,
    }
  }
}

export type StoreApiKeyFn = (providerId: string, apiKey: string) => Promise<boolean>

export async function persistProviderApiKey(
  providerEntry: ProviderConfig,
  providerId: string,
  apiKey: string | undefined,
  storeApiKey: StoreApiKeyFn,
): Promise<void> {
  if (!apiKey) return

  let storedInAuthStore = false
  try {
    storedInAuthStore = await storeApiKey(providerId, apiKey)
  } catch {
    // Auth store unavailable — fall back to config
  }
  if (!storedInAuthStore) {
    providerEntry.options!.apiKey = apiKey
  }
}
