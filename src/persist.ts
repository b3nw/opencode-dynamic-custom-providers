import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ProviderConfig } from "./types.js"

interface PathClient {
  path: {
    get: any
  }
}

interface LocalConfig {
  $schema?: string
  provider?: Record<string, ProviderConfig>
  [key: string]: unknown
}

async function readLocalConfig(filePath: string): Promise<LocalConfig> {
  try {
    const content = await fs.readFile(filePath, "utf8")
    return JSON.parse(content) as LocalConfig
  } catch {
    return {}
  }
}

export async function persistProvidersToLocalConfig(
  client: PathClient,
  providers: Record<string, ProviderConfig>,
  providerIds: string[],
): Promise<void> {
  if (providerIds.length === 0) return

  const { data } = await client.path.get()
  const directory = data?.directory
  if (!directory) {
    throw new Error("Unable to determine current workspace directory")
  }

  const filePath = path.join(directory, "config.json")
  const config = await readLocalConfig(filePath)
  const nextProviders = { ...(config.provider ?? {}) }

  for (const providerId of providerIds) {
    const provider = providers[providerId]
    if (!provider) continue
    nextProviders[providerId] = provider
  }

  const nextConfig: LocalConfig = {
    ...config,
    provider: nextProviders,
  }

  await fs.writeFile(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
}
