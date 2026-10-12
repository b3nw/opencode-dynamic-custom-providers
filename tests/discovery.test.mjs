import { test } from "node:test"
import assert from "node:assert"
import { fetchEndpointModels, normalizeModelId } from "../dist/discovery.js"

test("normalizeModelId strips models/ prefix and org prefixes", () => {
  assert.strictEqual(normalizeModelId("gpt-4o"), "gpt-4o")
  assert.strictEqual(normalizeModelId("models/gemini-2.5-flash"), "gemini-2.5-flash")
  assert.strictEqual(normalizeModelId("meta-llama/llama-3-8b"), "llama-3-8b")
  assert.strictEqual(normalizeModelId("openai/gpt-4o-mini"), "gpt-4o-mini")
})

test("normalizeModelId maps colons to hyphens", () => {
  assert.strictEqual(normalizeModelId("deepseek-ai/deepseek-coder:6.7b"), "deepseek-coder-6.7b")
})

const originalFetch = globalThis.fetch
const KEY = "synthetic-origin-key-0001"

async function requestFor(baseURL) {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init?.headers?.Authorization })
    return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })
  }
  try {
    await fetchEndpointModels(baseURL, KEY)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].authorization, `Bearer ${KEY}`)
  return requests[0].url
}

test("fetchEndpointModels keeps authority-looking base paths on the base origin", async () => {
  const cases = [
    ["https://approved.example//attacker.example/v1", "https://approved.example//attacker.example/v1/models"],
    ["https://approved.example///attacker.example/v1", "https://approved.example///attacker.example/v1/models"],
    ["https://approved.example//attacker.example", "https://approved.example//attacker.example/models"],
    ["https://approved.example//user@attacker.example/v1", "https://approved.example//user@attacker.example/v1/models"],
    ["https://approved.example/\\attacker.example/v1", "https://approved.example//attacker.example/v1/models"],
    ["https://approved.example//attacker.example/v1?a=1", "https://approved.example//attacker.example/v1/models?a=1"],
    ["http://127.0.0.1:8080//attacker.example:9000/v1", "http://127.0.0.1:8080//attacker.example:9000/v1/models"],
  ]
  for (const [base, expected] of cases) {
    const url = await requestFor(base)
    assert.strictEqual(new URL(url).origin, new URL(base).origin, `request origin for ${base}`)
    assert.strictEqual(url, expected)
  }
})

test("fetchEndpointModels builds the same models URL for normal base URLs", async () => {
  const cases = [
    ["https://example.test/v1", "https://example.test/v1/models"],
    ["https://example.test/v1/", "https://example.test/v1/models"],
    ["https://example.test", "https://example.test/models"],
    ["https://example.test/v1/models", "https://example.test/v1/models"],
    ["https://example.test/v1/models/", "https://example.test/v1/models"],
    ["https://example.test:8443/api/v1?x=1&y=2", "https://example.test:8443/api/v1/models?x=1&y=2"],
    ["https://example.test/v1#frag", "https://example.test/v1/models"],
    ["https://user:pass@example.test/v1", "https://example.test/v1/models"],
    ["https://example.test/v1?", "https://example.test/v1/models"],
  ]
  for (const [base, expected] of cases) {
    assert.strictEqual(await requestFor(base), expected)
  }
})
