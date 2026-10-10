import { test } from "node:test"
import assert from "node:assert/strict"
import { checkBaseURL, containsSecret, displayURL, redact, safeMessage, SafeError } from "../../packages/v2/dist/v2/secure.js"
import { discoverAndEnrich } from "../../packages/v2/dist/v2/discover.js"
import { startFixture, stubModelsDev } from "./helpers.mjs"

test("redact removes exact known secrets in raw, trimmed, case, URL, JSON and base64 forms", () => {
  const secret = " Arbitrary/Value+With=Punct "
  for (const form of [secret, secret.trim(), secret.trim().toUpperCase(), encodeURIComponent(secret.trim()), JSON.stringify(secret).slice(1, -1), Buffer.from(secret.trim()).toString("base64")]) {
    const out = redact(`HTTP 401: ${form} rejected`, [secret])
    assert.equal(out.toLowerCase().includes(secret.trim().toLowerCase()), false, form)
    assert.match(out, /\[REDACTED\]/)
  }
  assert.equal(redact("contains abc here", ["abc"]), "[diagnostic withheld: it may contain a credential]")
  assert.equal(redact("Bearer xyz123456 and api_key=foo", []), "Bearer [REDACTED] and api_key=[REDACTED]")
})

test("containsSecret only matches known secrets, so model IDs like task-1234 are kept", () => {
  assert.equal(containsSecret("task-1234", []), false)
  assert.equal(containsSecret("risk-model-v2", ["unrelated-secret"]), false)
  assert.equal(containsSecret("model-mysecretvalue", ["mysecretvalue"]), true)
})

test("safeMessage passes only package-made messages; host/network errors become generic categories", () => {
  assert.equal(safeMessage(new SafeError("HTTP 401 Unauthorized")), "HTTP 401 Unauthorized")
  assert.equal(safeMessage(new Error("raw body with secret-value-1234")), "unexpected error")
  assert.equal(safeMessage(Object.assign(new Error("x"), { name: "AbortError" })), "request timed out or was cancelled")
})

test("checkBaseURL policy: http(s) only, no user info, no query, no fragment; displayURL drops them", () => {
  assert.equal(checkBaseURL("https://api.example.com/v1").ok, true)
  for (const bad of ["ftp://x/v1", "http://u:p@x/v1", "http://x/v1?api_key=1", "http://x/v1?", "http://x/v1#f", "not a url"]) {
    assert.equal(checkBaseURL(bad).ok, false, bad)
  }
  assert.equal(displayURL("http://u:p@x.test/v1/?token=1#f"), "http://x.test/v1")
})

test("discovery drops model IDs or names that echo the credential", async () => {
  const restore = stubModelsDev({})
  const fixture = await startFixture({ models: ["ok-model", "leak-echoedsecret99", "task-1234", { id: "named", name: "echoedsecret99" }] })
  try {
    const result = await discoverAndEnrich(fixture.baseURL, { apiKey: "echoedsecret99", displayStyle: "name" })
    assert.deepEqual(Object.keys(result).sort(), ["named", "ok-model", "task-1234"])
    assert.equal(result.named.name, "named")
  } finally {
    restore()
    await fixture.close()
  }
})
