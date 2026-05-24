import { discoverAndEnrich, clearModelsDevCache, type DisplayStyle } from "./discovery.js"
import { isValidUrl, sanitizeErrorMessage } from "./security.js"
import { getApiKey, type ProviderConfig } from "./server.js"

export interface ReloadResult {
  totalModels: number
  failures: number
  providerCount: number
  warnings: string[]
  errors: string[]
}

export async function reloadAllProviders(
  providers: Record<string, ProviderConfig>,
): Promise<ReloadResult> {
  const dynamicProviders = Object.entries(providers).filter(
    ([, p]) => !!p.options?.baseURL && isValidUrl(p.options.baseURL),
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

  for (const [providerId, providerConfig] of dynamicProviders) {
    const baseURL = providerConfig.options!.baseURL!
    const apiKey = getApiKey(providerConfig, providerId)
    const displayStyle: DisplayStyle = providerConfig.displayStyle ?? "slug"

    try {
      const models = await discoverAndEnrich(baseURL, apiKey, displayStyle)
      const count = Object.keys(models).length

      if (count > 0) {
        providerConfig.models = { ...(providerConfig.models ?? {}), ...models }
        result.totalModels += count
      } else if (providerConfig.models && Object.keys(providerConfig.models).length > 0) {
        result.warnings.push(
          `${providerId} returned 0 models (keeping previous models). Check endpoint status.`,
        )
      }
    } catch (error) {
      result.failures++
      result.errors.push(`Failed to reload ${providerId}: ${sanitizeErrorMessage(error)}`)
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

export function validateAddProviderParams(
  params: AddProviderParams,
  existingProviders: Record<string, ProviderConfig>,
): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(params.providerId)) {
    return "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only."
  }
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
    }

    return {
      success: true,
      modelCount,
      message: `Provider '${params.providerId}' added (${modelCount} models discovered). Restart opencode to use it.`,
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
