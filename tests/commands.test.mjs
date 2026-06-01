import { test } from "node:test"
import assert from "node:assert"
import { reloadAllProviders } from "../dist/commands.js"

const originalFetch = globalThis.fetch

test("reloadAllProviders replaces stale provider models", async () => {
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
    const providers = {
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
    }

    const result = await reloadAllProviders(providers)

    assert.strictEqual(result.providerCount, 1)
    assert.strictEqual(result.failures, 0)
    assert.strictEqual(result.totalModels, 1)
    assert.deepStrictEqual(result.updatedProviderIds, ["custom"])
    assert.deepStrictEqual(Object.keys(providers.custom.models), ["fresh-model"])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("reloadAllProviders includes providers with baseURL even without dynamic flag", async () => {
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
    const providers = {
      custom: {
        options: { baseURL: "https://example.test/v1" },
        models: {
          "stale-model": {
            name: "stale-model",
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    }

    const result = await reloadAllProviders(providers)

    assert.strictEqual(result.providerCount, 1)
    assert.strictEqual(result.failures, 0)
    assert.deepStrictEqual(result.updatedProviderIds, ["custom"])
    assert.deepStrictEqual(Object.keys(providers.custom.models), ["fresh-model"])
  } finally {
    globalThis.fetch = originalFetch
  }
})
