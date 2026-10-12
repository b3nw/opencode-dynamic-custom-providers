import type { DisplayStyle } from "./discover.js"

/** Per-provider plugin-owned options, configured under the plugin entry's `options.providers`. */
export interface ProviderOptions {
  /** `true` opts a provider in even if it has explicit models; `false` opts it out entirely. */
  readonly discover?: boolean
  readonly displayStyle?: DisplayStyle
}

export interface PluginOptions {
  readonly displayStyle: DisplayStyle
  readonly providers: Readonly<Record<string, ProviderOptions>>
  /**
   * Extra origins (`scheme://host[:port]`) the agent `add-provider` tool may probe, in
   * addition to origins of already configured dynamic providers. User-owned approval;
   * new-provider adds by the tool are still credential-free.
   */
  readonly agentOrigins: readonly string[]
}

function displayStyle(value: unknown): DisplayStyle | undefined {
  return value === "slug" || value === "name" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Exact http(s) origin of `value`, or undefined if it is anything else (paths, queries, credentials). */
function originOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    if (url.pathname !== "/" && url.pathname !== "") return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** Narrows untrusted `ctx.options`; unknown keys and malformed values are ignored. */
export function parseOptions(raw: unknown): PluginOptions {
  const input = isRecord(raw) ? raw : {}
  const providers: Record<string, ProviderOptions> = {}
  if (isRecord(input.providers)) {
    for (const [id, value] of Object.entries(input.providers)) {
      if (!isRecord(value)) continue
      providers[id] = {
        ...(typeof value.discover === "boolean" ? { discover: value.discover } : {}),
        ...(displayStyle(value.displayStyle) ? { displayStyle: displayStyle(value.displayStyle) } : {}),
      }
    }
  }
  const agentOrigins = Array.isArray(input.agentOrigins)
    ? [...new Set(input.agentOrigins.map(originOf).filter((value): value is string => value !== undefined))]
    : []
  return {
    displayStyle: displayStyle(input.displayStyle) ?? "slug",
    providers,
    agentOrigins,
  }
}
