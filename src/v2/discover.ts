import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CancelledError, SafeError, containsSecret } from "./secure.js"

/**
 * V2 endpoint discovery and models.dev enrichment. Mirrors the V1 enrichment
 * rules, but owns its network behaviour: caller AbortSignals, a fixed redirect
 * policy, and diagnostics that never include remote response bodies.
 */

export type DisplayStyle = "name" | "slug"

export interface EnrichedModel {
  name: string
  family?: string
  release_date?: string
  status?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; input?: number; output: number }
  modalities?: { input: string[]; output: string[] }
}

interface ModelsDevModel {
  id: string
  name: string
  family?: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; input?: number; output: number }
  modalities?: { input: string[]; output: string[] }
  status?: string
}

interface EndpointModel {
  id: string
  name?: string
  context_length?: number
  max_completion_tokens?: number
  max_output_tokens?: number
  max_model_len?: number
  context_window?: number
  input_cost?: number
  output_cost?: number
  capabilities?: { tool_choice?: boolean; function_calling?: boolean; reasoning?: boolean; temperature?: boolean }
  supported_parameters?: string[]
}

export interface DiscoverOptions {
  readonly apiKey?: string
  readonly signal?: AbortSignal
  readonly displayStyle?: DisplayStyle
  /** Secrets that must never appear in returned model IDs/names (e.g. the key, URL query values). */
  readonly secrets?: readonly string[]
}

const MODELS_DEV_URL = "https://models.dev/api.json"
/** models.dev cache under `$XDG_CACHE_HOME` (default `~/.cache`), resolved per use. */
function cacheFile(): string {
  const root = process.env.XDG_CACHE_HOME || path.join(os.homedir() || os.tmpdir(), ".cache")
  return path.join(root, "opencode-dynamic-providers-v2", "models-dev.json")
}
const CACHE_TTL = 6 * 60 * 60 * 1000
const ENDPOINT_TIMEOUT = 15_000
const CATALOG_TIMEOUT = 10_000
const MAX_REDIRECTS = 3
const MAX_BODY = 8 * 1024 * 1024

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

// ── models.dev catalog ──

let lookup: Promise<Map<string, ModelsDevModel>> | null = null

export function clearModelsDevCache(): void {
  lookup = null
  try {
    fs.rmSync(cacheFile(), { force: true })
  } catch {
    // ignore
  }
}

export function normalizeModelId(id: string): string {
  let normalized = id.toLowerCase()
  if (normalized.startsWith("models/")) normalized = normalized.slice(7)
  const slash = normalized.lastIndexOf("/")
  if (slash !== -1) normalized = normalized.slice(slash + 1)
  return normalized.replaceAll(":", "-")
}

export function sanitizeModelId(id: string): string {
  return id.trim().replaceAll(/[^a-zA-Z0-9/_\-:.]/g, "_")
}

function readCache(): { timestamp: number; data: Record<string, { models?: Record<string, ModelsDevModel> }> } | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"))
  } catch {
    return null
  }
}

function writeCache(data: unknown): void {
  try {
    const file = cacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now(), data }), { mode: 0o600 })
  } catch {
    // ignore
  }
}

async function loadCatalog(signal?: AbortSignal): Promise<Record<string, { models?: Record<string, ModelsDevModel> }>> {
  const entry = readCache()
  if (entry && Date.now() - entry.timestamp <= CACHE_TTL) return entry.data
  try {
    const timeout = AbortSignal.timeout(CATALOG_TIMEOUT)
    const res = await fetch(MODELS_DEV_URL, {
      headers: { "User-Agent": "opencode-dynamic-custom-providers-v2" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (res.ok) {
      const data = (await res.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>
      writeCache(data)
      return data
    }
  } catch {
    // fall back to stale cache
  }
  return entry?.data ?? {}
}

function getLookup(signal?: AbortSignal): Promise<Map<string, ModelsDevModel>> {
  if (!lookup) {
    const pending = loadCatalog(signal).then((catalog) => {
      const map = new Map<string, ModelsDevModel>()
      for (const provider of Object.values(catalog)) {
        for (const model of Object.values(provider?.models ?? {})) {
          if (typeof model?.id !== "string") continue
          const key = normalizeModelId(model.id)
          if (!map.has(key)) map.set(key, model)
        }
      }
      return map
    })
    lookup = pending
    // A cancelled load must not poison later callers.
    pending.then(
      (map) => {
        if (map.size === 0 && signal?.aborted && lookup === pending) lookup = null
      },
      () => {
        if (lookup === pending) lookup = null
      },
    )
  }
  return lookup
}

// ── endpoint ──

/**
 * `<baseURL>/models` with the base query. The path is set on the parsed URL, never
 * re-parsed as a relative reference: a base path such as `//other.host/v1` must stay
 * a path on the base origin, not become a new authority.
 */
export function modelsURL(baseURL: string): URL {
  const url = new URL(baseURL)
  const target = new URL(url.href)
  target.username = ""
  target.password = ""
  target.hash = ""
  const clean = url.pathname.replace(/\/+$/, "")
  target.pathname = clean.endsWith("/models") ? clean : `${clean}/models`
  if (target.origin !== url.origin) throw new SafeError("models URL does not match the base URL origin", "invalid")
  return target
}

function networkMessage(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } })?.cause
  const code = typeof cause?.code === "string" ? cause.code : typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : ""
  if (code === "ECONNREFUSED") return "connection refused"
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found"
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "connection reset"
  if (code.startsWith("ERR_TLS") || code.includes("CERT")) return "TLS error"
  return "network error"
}

/**
 * GET <baseURL>/models. Credentials are only sent to the base URL's origin:
 * same-origin redirects are followed (at most 3, credentials kept); a redirect
 * to any other origin is rejected without being requested.
 */
export async function fetchEndpointModels(baseURL: string, options: DiscoverOptions = {}): Promise<EndpointModel[]> {
  const start = modelsURL(baseURL)
  const timeout = AbortSignal.timeout(ENDPOINT_TIMEOUT)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const headers: Record<string, string> = { Accept: "application/json" }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`

  let target = start
  let res: Response | undefined
  for (let hop = 0; ; hop++) {
    if (options.signal?.aborted) throw new CancelledError()
    try {
      res = await fetch(target, { headers, signal, redirect: "manual" })
    } catch (error) {
      if (options.signal?.aborted) throw new CancelledError()
      if (timeout.aborted) throw new SafeError("request timed out", "timeout")
      throw new SafeError(networkMessage(error), "network")
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) break
    await res.body?.cancel().catch(() => undefined)
    const location = res.headers.get("location")
    if (!location) throw new SafeError(`HTTP ${res.status} redirect without a location`, "redirect")
    let next: URL
    try {
      next = new URL(location, target)
    } catch {
      throw new SafeError(`HTTP ${res.status} redirect to an invalid location`, "redirect")
    }
    if (next.origin !== start.origin) {
      throw new SafeError(
        `HTTP ${res.status} redirect to a different origin was not followed (credentials are only sent to ${start.origin}). Update the provider base URL instead.`,
        "redirect",
      )
    }
    if (hop + 1 >= MAX_REDIRECTS) throw new SafeError("too many redirects", "redirect")
    target = next
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    const phrase = STATUS_TEXT[res.status]
    throw new SafeError(`HTTP ${res.status}${phrase ? ` ${phrase}` : ""}`, "http")
  }
  let raw: unknown
  try {
    const text = await res.text()
    if (text.length > MAX_BODY) throw new SafeError("response too large", "format")
    raw = JSON.parse(text)
  } catch (error) {
    if (error instanceof SafeError) throw error
    if (options.signal?.aborted) throw new CancelledError()
    if (timeout.aborted) throw new SafeError("request timed out", "timeout")
    throw new SafeError("endpoint did not return valid JSON", "format")
  }
  const data = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : null
  if (!data) throw new SafeError("unexpected response format from /models", "format")
  return data.filter((item): item is EndpointModel => typeof (item as { id?: unknown })?.id === "string")
}

function capabilities(item: EndpointModel) {
  let toolCall = false
  let reasoning = false
  let temperature = false
  if (item.capabilities) {
    if (item.capabilities.function_calling || item.capabilities.tool_choice) toolCall = true
    if (item.capabilities.reasoning) reasoning = true
    if (item.capabilities.temperature) temperature = true
  }
  if (Array.isArray(item.supported_parameters)) {
    if (item.supported_parameters.includes("tools") || item.supported_parameters.includes("tool_choice")) toolCall = true
    if (item.supported_parameters.includes("temperature")) temperature = true
  }
  return { toolCall, reasoning, temperature }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

/**
 * Discovers and enriches models. Model IDs/names that echo a known secret are
 * dropped so a hostile endpoint cannot reflect a credential into the model list.
 */
export async function discoverAndEnrich(baseURL: string, options: DiscoverOptions = {}): Promise<Record<string, EnrichedModel>> {
  const items = await fetchEndpointModels(baseURL, options)
  if (options.signal?.aborted) throw new CancelledError()
  const table = await getLookup(options.signal)
  if (options.signal?.aborted) throw new CancelledError()
  const secrets = [options.apiKey, ...(options.secrets ?? [])].filter((value): value is string => !!value)
  const result: Record<string, EnrichedModel> = {}
  for (const item of items) {
    const id = sanitizeModelId(item.id)
    if (secrets.length > 0 && (containsSecret(item.id, secrets) || containsSecret(id, secrets))) continue
    const meta = table.get(normalizeModelId(id))
    const caps = capabilities(item)
    const remoteName = typeof item.name === "string" && item.name !== item.id && !containsSecret(item.name, secrets) ? item.name : undefined
    const model: EnrichedModel = {
      name: options.displayStyle === "name" ? remoteName ?? meta?.name ?? id : id,
      limit: {
        context: num(item.context_window ?? item.max_model_len ?? item.context_length) ?? meta?.limit?.context ?? 128_000,
        input: meta?.limit?.input,
        output: num(item.max_completion_tokens ?? item.max_output_tokens) ?? meta?.limit?.output ?? 4096,
      },
      modalities: meta?.modalities ?? { input: ["text"], output: ["text"] },
    }
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
      // Unknown models default to no tool calls.
      if (caps.reasoning) model.reasoning = true
      if (caps.temperature) model.temperature = true
      if (caps.toolCall) model.tool_call = true
      if (typeof item.input_cost === "number" || typeof item.output_cost === "number") {
        model.cost = { input: num(item.input_cost) ?? 0, output: num(item.output_cost) ?? 0 }
      }
    }
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
