import { test } from "node:test"
import assert from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { persistProvidersToLocalConfig } from "../dist/persist.js"

test("persistProvidersToLocalConfig replaces provider models on disk", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-dynamic-providers-"))
  const filePath = path.join(directory, "config.json")

  await fs.writeFile(filePath, JSON.stringify({
    provider: {
      "llm-proxy": {
        options: { baseURL: "https://example.test/v1" },
        models: {
          stale: { name: "stale", limit: { context: 1, output: 1 } },
        },
      },
    },
  }, null, 2))

  await persistProvidersToLocalConfig(
    {
      path: {
        get: async () => ({ data: { directory } }),
      },
    },
    {
      "llm-proxy": {
        options: { baseURL: "https://example.test/v1" },
        models: {
          fresh: { name: "fresh", limit: { context: 2, output: 2 } },
        },
      },
    },
    ["llm-proxy"],
  )

  const written = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.deepStrictEqual(Object.keys(written.provider["llm-proxy"].models), ["fresh"])

  await fs.rm(directory, { recursive: true, force: true })
})
