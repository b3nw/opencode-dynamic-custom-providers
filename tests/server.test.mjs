import { test } from "node:test"
import assert from "node:assert"
import { server } from "../dist/server.js"

const originalFetch = globalThis.fetch

test("server config discovery replaces stale dynamic provider models", async () => {
  globalThis.fetch = async (url) => {
    const value = String(url)
    if (value === "https://models.dev/api.json") {
      return new Response(JSON.stringify({}), { status: 200 })
    }
    if (value === "https://example.test/v1/models") {
      return new Response(JSON.stringify({ data: [{ id: "fresh-model" }] }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${value}`)
  }

  try {
    const plugin = await server({
      client: {
        app: { log: async () => undefined },
      },
    })

    const config = {
      provider: {
        custom: {
          dynamic: true,
          options: { baseURL: "https://example.test/v1" },
          models: {
            "stale-model": {
              name: "stale-model",
              limit: { context: 128000, output: 4096 },
            },
          },
        },
      },
    }

    await plugin.config(config)

    assert.deepStrictEqual(Object.keys(config.provider.custom.models), ["fresh-model"])
  } finally {
    globalThis.fetch = originalFetch
  }
})
