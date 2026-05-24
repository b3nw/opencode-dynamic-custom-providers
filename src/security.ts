const VALID_PROTOCOLS = new Set(["http:", "https:"])

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return VALID_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

export function sanitizeModelId(id: string): string {
  return id.trim().replaceAll(/[^a-zA-Z0-9/_\-:.]/g, "_")
}

export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ""
    url.password = ""
    url.search = ""
    return url.toString()
  } catch {
    return raw.split("?")[0]
  }
}

export function sanitizeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  
  message = message.replaceAll(/https?:\/\/[^\s"'`<>]+/gi, (match) =>
    sanitizeUrl(match),
  )

  return message
    .replaceAll(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replaceAll(/api[_-]?key[=:]\s*[^\s&]+/gi, "api_key=[REDACTED]")
    .replaceAll(/sk-[a-zA-Z0-9_-]+/g, "sk-[REDACTED]")
}

