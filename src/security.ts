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

export function sanitizeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  
  // Strip query parameters from any URLs inside the error message
  message = message.replaceAll(/https?:\/\/[^\s"'`<>]+/gi, (match) => {
    try {
      const url = new URL(match)
      if (url.search) {
        url.search = ""
        return url.toString()
      }
      return match
    } catch {
      return match.split("?")[0]
    }
  })

  return message
    .replaceAll(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replaceAll(/api[_-]?key[=:]\s*[^\s&]+/gi, "api_key=[REDACTED]")
    .replaceAll(/sk-[a-zA-Z0-9_-]+/g, "sk-[REDACTED]")
}

