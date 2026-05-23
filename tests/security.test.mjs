import { test } from "node:test"
import assert from "node:assert"
import { isValidUrl, sanitizeModelId, sanitizeErrorMessage } from "../dist/security.js"

test("isValidUrl checks protocols correctly", () => {
  assert.strictEqual(isValidUrl("https://api.openai.com"), true)
  assert.strictEqual(isValidUrl("http://localhost:8080"), true)
  assert.strictEqual(isValidUrl("ftp://api.openai.com"), false)
  assert.strictEqual(isValidUrl("invalid-url"), false)
})

test("sanitizeModelId replaces invalid characters", () => {
  assert.strictEqual(sanitizeModelId("gpt-4o"), "gpt-4o")
  assert.strictEqual(sanitizeModelId("meta-llama/llama-3"), "meta-llama/llama-3")
  assert.strictEqual(sanitizeModelId("google:gemini-pro"), "google:gemini-pro")
  assert.strictEqual(sanitizeModelId("model$with#special%chars"), "model_with_special_chars")
})

test("sanitizeErrorMessage redacts sensitive information and strips URL query parameters", () => {
  const errorWithKey = "Failed with apiKey=sk-1234567890abcdef"
  assert.ok(!sanitizeErrorMessage(errorWithKey).includes("1234567890"))
  assert.ok(sanitizeErrorMessage(errorWithKey).includes("[REDACTED]"))

  const errorWithBearer = "Authorization failed: Bearer secret_token_here"
  assert.ok(!sanitizeErrorMessage(errorWithBearer).includes("secret_token_here"))
  assert.ok(sanitizeErrorMessage(errorWithBearer).includes("[REDACTED]"))

  const errorWithUrlParams = "Failed to fetch https://api.proxy.com/v1/models?api_key=secret123&foo=bar"
  assert.strictEqual(sanitizeErrorMessage(errorWithUrlParams), "Failed to fetch https://api.proxy.com/v1/models")

  const errorWithProjKey = "key was sk-proj-abc_def-123 in request"
  assert.ok(!sanitizeErrorMessage(errorWithProjKey).includes("abc_def"))
  assert.ok(sanitizeErrorMessage(errorWithProjKey).includes("sk-[REDACTED]"))
})
