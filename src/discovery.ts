import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createRequire } from "node:module"
import { isValidUrl, sanitizeModelId } from "./security.js"

const require = createRequire(import.meta.url)
const { version: PKG_VERSION } = require("../package.json")

const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_DIR = path.join(
  os.homedir() || "/tmp",
  ".cache",
  "opencode-dynamic-providers",
)
const CACHE_FILE = path.join(CACHE_DIR, "models-dev.json")
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6 hours


// ── models.dev types (subset matching OpenCode's schema) ──

interface ModelsDevModel {
  id: string
  name: string
  family?: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
  limit: {
    context: number
    input?: number
    output: number
  }
  modalities?: {
    input: string[]
    output: string[]
  }
  status?: string
}

interface ModelsDevProvider {
  id: string
  name: string
  npm?: string
  api?: string
  models: Record<string, ModelsDevModel>
}

// ── models.dev cache + lookup ──

// Module-level singleton: built once per process on first access, then shared
// across all providers in a single startup cycle. Cleared by clearModelsDevCache()
// (e.g. via the reload-models TUI command) so the next discoverAndEnrich call
// rebuilds it with fresh data.
let lookupMap: Map<string, ModelsDevModel> | null = null

export function normalizeModelId(id: string): string {
  let normalized = id.toLowerCase()
  if (normalized.startsWith("models/")) {
    normalized = normalized.slice(7)
  }
  const slashIndex = normalized.lastIndexOf("/")
  if (slashIndex !== -1) {
    normalized = normalized.slice(slashIndex + 1)
  }
  return normalized.replaceAll(":", "-")
}

interface CacheEntry {
  timestamp: number
  data: Record<string, ModelsDevProvider>
}

function readCacheEntry(): CacheEntry | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null
    const content = fs.readFileSync(CACHE_FILE, "utf-8")
    return JSON.parse(content) as CacheEntry
  } catch {
    return null
  }
}

function writeCache(data: Record<string, ModelsDevProvider>): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { mode: 0o700, recursive: true })
    }
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ timestamp: Date.now(), data }, null, 2),
      { mode: 0o600 },
    )
  } catch {
    // ignore write errors
  }
}

async function fetchModelsDevCatalog(): Promise<Record<string, ModelsDevProvider>> {
  const entry = readCacheEntry()
  const isFresh = entry && (Date.now() - entry.timestamp <= CACHE_TTL)
  if (isFresh && entry) return entry.data

  try {
    const res = await fetch(MODELS_DEV_URL, {
      headers: { "User-Agent": `opencode-dynamic-custom-providers/${PKG_VERSION}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = await res.json() as Record<string, ModelsDevProvider>
      writeCache(data)
      return data
    }
  } catch {
    // Ignore fetch error, fall back to stale cache if available
  }

  if (entry) {
    return entry.data
  }

  return {}
}

function buildLookupMap(catalog: Record<string, ModelsDevProvider>): Map<string, ModelsDevModel> {
  const map = new Map<string, ModelsDevModel>()
  for (const provider of Object.values(catalog)) {
    if (!provider.models) continue
    for (const model of Object.values(provider.models)) {
      const key = normalizeModelId(model.id)
      if (!map.has(key)) {
        map.set(key, model)
      }
    }
  }
  return map
}

async function getLookupMap(): Promise<Map<string, ModelsDevModel>> {
  if (lookupMap) return lookupMap
  const catalog = await fetchModelsDevCatalog()
  lookupMap = buildLookupMap(catalog)
  return lookupMap
}

export function clearModelsDevCache(): void {
  lookupMap = null
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE)
  } catch {
    // ignore
  }
}

// ── endpoint model response types ──

interface EndpointModelResponse {
  id: string
  name?: string
  context_length?: number
  max_completion_tokens?: number
  max_output_tokens?: number
  max_model_len?: number
  context_window?: number
  input_cost?: number
  output_cost?: number
  capabilities?: {
    tool_choice?: boolean
    function_calling?: boolean
    reasoning?: boolean
    vision?: boolean
    temperature?: boolean
    structured_output?: boolean
  }
  supported_parameters?: string[]
}

// ── endpoint discovery ──

export async function fetchEndpointModels(
  baseURL: string,
  apiKey?: string,
): Promise<EndpointModelResponse[]> {
  if (!isValidUrl(baseURL)) return []

  const url = new URL(baseURL)
  const modelsPath = url.pathname.endsWith("/models")
    ? url.pathname
    : `${url.pathname.replace(/\/+$/, "")}/models`
  const modelsUrl = new URL(modelsPath, url.origin)
  modelsUrl.search = url.search

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  const res = await fetch(modelsUrl.toString(), {
    headers,
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  }

  const rawData = await res.json()
  const data = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData?.data)
      ? rawData.data
      : null

  if (!data) {
    throw new Error("Unexpected response format from /v1/models")
  }

  return data.filter((item: Record<string, unknown>) => typeof item?.id === "string")
}

// ── enrichment: merge endpoint data with models.dev ──

export interface EnrichedModel {
  name: string
  family?: string
  release_date?: string
  status?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
  limit: {
    context: number
    input?: number
    output: number
  }
  modalities?: {
    input: string[]
    output: string[]
  }
}

function parseEndpointCapabilities(item: EndpointModelResponse) {
  let toolCall = false
  let reasoning = false
  let temperature = false

  if (item.capabilities) {
    if (item.capabilities.function_calling || item.capabilities.tool_choice) toolCall = true
    if (item.capabilities.reasoning) reasoning = true
    if (item.capabilities.temperature) temperature = true
  }

  if (item.supported_parameters) {
    if (item.supported_parameters.includes("tools") || item.supported_parameters.includes("tool_choice")) {
      toolCall = true
    }
    if (item.supported_parameters.includes("temperature")) {
      temperature = true
    }
  }

  return { toolCall, reasoning, temperature }
}

function endpointContextWindow(item: EndpointModelResponse): number | undefined {
  const v = item.context_window ?? item.max_model_len ?? item.context_length
  return typeof v === "number" ? v : undefined
}

function endpointMaxOutput(item: EndpointModelResponse): number | undefined {
  const v = item.max_completion_tokens ?? item.max_output_tokens
  return typeof v === "number" ? v : undefined
}

export type DisplayStyle = "name" | "slug"

export async function discoverAndEnrich(
  baseURL: string,
  apiKey?: string,
  displayStyle: DisplayStyle = "slug",
): Promise<Record<string, EnrichedModel>> {
  const rawModels = await fetchEndpointModels(baseURL, apiKey)
  const lookup = await getLookupMap()
  const result: Record<string, EnrichedModel> = {}

  for (const item of rawModels) {
    const id = sanitizeModelId(item.id)
    const key = normalizeModelId(id)
    const meta = lookup.get(key)
    const caps = parseEndpointCapabilities(item)

    const epContext = endpointContextWindow(item)
    const epOutput = endpointMaxOutput(item)

    const displayName = displayStyle === "slug"
      ? id
      : (item.name && item.name !== item.id ? item.name : undefined) ?? meta?.name ?? id

    const model: EnrichedModel = {
      name: displayName,
      limit: {
        context: epContext ?? meta?.limit.context ?? 128_000,
        input: meta?.limit.input,
        output: epOutput ?? meta?.limit.output ?? 4096,
      },
      modalities: meta?.modalities ?? { input: ["text"], output: ["text"] },
    }

    // Capabilities: prefer models.dev when available, fall back to endpoint-detected
    if (meta) {
      model.reasoning = caps.reasoning || meta.reasoning
      model.temperature = caps.temperature || meta.temperature
      model.tool_call = caps.toolCall || meta.tool_call
      model.attachment = meta.attachment
      model.family = meta.family
      model.release_date = meta.release_date
      model.status = meta.status
      model.cost = {
        input: meta.cost?.input ?? 0,
        output: meta.cost?.output ?? 0,
        cache_read: meta.cost?.cache_read,
        cache_write: meta.cost?.cache_write,
      }
    } else {
      // No models.dev match — use whatever the endpoint told us, with safe defaults.
      // tool_call defaults to false for unknown models to avoid sending tool calls
      // to endpoints that don't support them.
      if (caps.reasoning) model.reasoning = true
      if (caps.temperature) model.temperature = true
      if (caps.toolCall) model.tool_call = true

      if (typeof item.input_cost === "number" || typeof item.output_cost === "number") {
        model.cost = {
          input: typeof item.input_cost === "number" ? item.input_cost : 0,
          output: typeof item.output_cost === "number" ? item.output_cost : 0,
        }
      }
    }

    // Strip false/undefined booleans so OpenCode's fallback chain works cleanly
    if (!model.reasoning) delete model.reasoning
    if (!model.temperature) delete model.temperature
    if (!model.attachment) delete model.attachment
    if (model.family === undefined) delete model.family
    if (model.release_date === undefined) delete model.release_date
    if (model.status === undefined) delete model.status

    result[id] = model
  }

  return result
}
