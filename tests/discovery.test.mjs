import { test } from "node:test"
import assert from "node:assert"
import { normalizeModelId } from "../dist/discovery.js"

test("normalizeModelId strips models/ prefix and org prefixes", () => {
  assert.strictEqual(normalizeModelId("gpt-4o"), "gpt-4o")
  assert.strictEqual(normalizeModelId("models/gemini-2.5-flash"), "gemini-2.5-flash")
  assert.strictEqual(normalizeModelId("meta-llama/llama-3-8b"), "llama-3-8b")
  assert.strictEqual(normalizeModelId("openai/gpt-4o-mini"), "gpt-4o-mini")
})

test("normalizeModelId maps colons to hyphens", () => {
  assert.strictEqual(normalizeModelId("deepseek-ai/deepseek-coder:6.7b"), "deepseek-coder-6.7b")
})
