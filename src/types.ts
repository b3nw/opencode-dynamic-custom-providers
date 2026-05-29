import { isValidUrl } from "./security.js"

import type { DisplayStyle } from "./discovery.js"

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

export interface OpenCodeConfig {
  provider?: Record<string, ProviderConfig>
  [key: string]: unknown
}

export function getApiKey(provider: ProviderConfig, providerId: string): string | undefined {
  if (provider.options?.apiKey) return provider.options.apiKey
  const envKey = `OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`
  return process.env[envKey]
}

export function shouldDiscover(provider: ProviderConfig): boolean {
  const baseURL = provider.options?.baseURL
  if (!baseURL || !isValidUrl(baseURL)) return false
  if (provider.dynamic === true) return true
  const models = provider.models
  return !models || Object.keys(models).length === 0
}
