// Regression: the /models request URL must stay on the base URL's origin. A base path
// that looks like an authority (`//host/...`) must not be re-parsed as a new host, and
// credentials must only ever be attached to the approved origin. Synthetic keys,
// mocked fetch and a loopback fixture only.
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import plugin from "../../packages/v2/dist/v2/server.js"
import { clearModelsDevCache, discoverAndEnrich, fetchEndpointModels, modelsURL } from "../../packages/v2/dist/v2/discover.js"
import { createHost, settle, startFixture, stubModelsDev, tempDir } from "./helpers.mjs"

const KEY = "synthetic-origin-key-0001"
const APPROVED = "https://approved.example"

const AUTHORITY_LOOKING = [
  [`${APPROVED}//attacker.example/v1`, "//attacker.example/v1/models"],
  [`${APPROVED}///attacker.example/v1`, "///attacker.example/v1/models"],
  [`${APPROVED}////attacker.example:8443/v1/`, "////attacker.example:8443/v1/models"],
  [`${APPROVED}//attacker.example`, "//attacker.example/models"],
  [`${APPROVED}//user@attacker.example/v1`, "//user@attacker.example/v1/models"],
  [`${APPROVED}/\\attacker.example/v1`, "//attacker.example/v1/models"],
  [`${APPROVED}//attacker.example/v1/models`, "//attacker.example/v1/models"],
  [`${APPROVED}//attacker.example/v1?api-version=2`, "//attacker.example/v1/models"],
  [`${APPROVED}:8443//attacker.example/v1`, "//attacker.example/v1/models"],
  ["http://127.0.0.1:9//attacker.example/v1", "//attacker.example/v1/models"],
]

test("modelsURL keeps the base origin for authority-looking (double/multiple-slash) paths", () => {
  for (const [base, pathname] of AUTHORITY_LOOKING) {
    const url = modelsURL(base)
    assert.equal(url.origin, new URL(base).origin, base)
    assert.equal(url.pathname, pathname, base)
    assert.equal(url.search, new URL(base).search, base)
  }
})

test("modelsURL normal paths, queries and already-/models paths are unchanged", () => {
  const cases = [
    [`${APPROVED}`, `${APPROVED}/models`],
    [`${APPROVED}/`, `${APPROVED}/models`],
    [`${APPROVED}/v1`, `${APPROVED}/v1/models`],
    [`${APPROVED}/v1/`, `${APPROVED}/v1/models`],
    [`${APPROVED}/api/openai/v1`, `${APPROVED}/api/openai/v1/models`],
    [`${APPROVED}/v1/models`, `${APPROVED}/v1/models`],
    [`${APPROVED}/v1/models/`, `${APPROVED}/v1/models`],
    [`${APPROVED}/models`, `${APPROVED}/models`],
    [`${APPROVED}/v1?api-version=2024-01`, `${APPROVED}/v1/models?api-version=2024-01`],
    [`${APPROVED}/v1/models?api-version=2024-01&x=y`, `${APPROVED}/v1/models?api-version=2024-01&x=y`],
    [`${APPROVED}:8443/v1`, `${APPROVED}:8443/v1/models`],
    ["http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1/models"],
    [`${APPROVED}/v1#frag`, `${APPROVED}/v1/models`],
    ["https://u:p@approved.example/v1", `${APPROVED}/v1/models`],
  ]
  for (const [base, expected] of cases) assert.equal(modelsURL(base).href, expected, base)
})

/** Records every fetch (URL + Authorization) and answers from memory; nothing leaves the process. */
function recordingFetch(respond = () => Response.json({ data: [{ id: "m1" }] })) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const auth = new Headers(init?.headers).get("authorization")
    calls.push({ url, origin: new URL(url).origin, auth })
    if (url === "https://models.dev/api.json") return Response.json({})
    return respond(url)
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

test("authenticated fetchEndpointModels: first request and credential stay on the approved origin", async () => {
  for (const [base, pathname] of AUTHORITY_LOOKING) {
    const rec = recordingFetch()
    try {
      const items = await fetchEndpointModels(base, { apiKey: KEY })
      assert.deepEqual(items.map((m) => m.id), ["m1"])
    } finally {
      rec.restore()
    }
    assert.equal(rec.calls.length, 1, base)
    const [call] = rec.calls
    assert.equal(call.origin, new URL(base).origin, `request origin for ${base}`)
    assert.equal(new URL(call.url).pathname, pathname, base)
    assert.equal(call.auth, `Bearer ${KEY}`)
    assert.equal(rec.calls.some((c) => c.url.includes("://attacker.example")), false, base)
  }
})

test("authenticated discoverAndEnrich never sends the credential off the approved origin", async () => {
  clearModelsDevCache()
  const rec = recordingFetch()
  try {
    const result = await discoverAndEnrich(`${APPROVED}//attacker.example/v1`, { apiKey: KEY })
    assert.deepEqual(Object.keys(result), ["m1"])
  } finally {
    rec.restore()
  }
  const withAuth = rec.calls.filter((c) => c.auth)
  assert.deepEqual(withAuth.map((c) => c.url), [`${APPROVED}//attacker.example/v1/models`])
  assert.equal(rec.calls.some((c) => c.origin === "https://attacker.example"), false)
})

test("redirect policy still binds to the base origin for an authority-looking path", async () => {
  const rec = recordingFetch((url) =>
    url.startsWith(APPROVED)
      ? new Response(null, { status: 302, headers: { location: "https://attacker.example/v1/models" } })
      : Response.json({ data: [{ id: "stolen" }] }),
  )
  try {
    await assert.rejects(fetchEndpointModels(`${APPROVED}//attacker.example/v1`, { apiKey: KEY }), /redirect to a different origin was not followed/)
  } finally {
    rec.restore()
  }
  assert.deepEqual(rec.calls.map((c) => c.origin), [APPROVED])
})

// ── add-provider flow (trusted RPC, with an API key) ──

let restore
let fixture
beforeEach(async () => {
  clearModelsDevCache()
  fixture = await startFixture({ models: ["alpha"] })
})
afterEach(async () => {
  restore?.()
  restore = undefined
  await fixture.close()
})

test("add-provider with an authority-looking base path authenticates only against the approved loopback origin", async () => {
  const unstub = stubModelsDev({})
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ origin: new URL(url).origin, url, auth: new Headers(init?.headers).get("authorization") })
    return original(input, init)
  }
  restore = () => {
    globalThis.fetch = original
    unstub()
  }
  const directory = await tempDir()
  const host = createHost({ directory })
  await plugin.setup(host)
  await settle()
  const approved = new URL(fixture.baseURL).origin
  const baseURL = `${approved}//attacker.example/v1`
  const result = await host.rpcs.at(-1).handlers.addProvider({ providerID: "slashy", baseURL, apiKey: KEY })

  const authed = calls.filter((c) => c.auth)
  assert.ok(authed.length > 0, "discovery was attempted with the key")
  for (const call of authed) assert.equal(call.origin, approved, `credential sent to ${call.url}`)
  assert.equal(calls.some((c) => c.origin !== approved && c.url !== "https://models.dev/api.json"), false, JSON.stringify(calls))
  assert.deepEqual(fixture.state.seenPaths, ["//attacker.example/v1/models"])
  assert.deepEqual(fixture.state.seenAuth, [`Bearer ${KEY}`])
  // The loopback fixture only serves /v1/models, so this base path is simply not a provider.
  assert.equal(result.ok, false)
  assert.equal(result.code, "discovery_failed")
  assert.match(result.message, /HTTP 404/)
  assert.equal(await fs.stat(path.join(directory, "opencode.jsonc")).then(() => true, () => false), false)
})

test("add-provider with a normal base path still succeeds on the approved origin", async () => {
  restore = stubModelsDev({})
  const directory = await tempDir()
  const host = createHost({ directory })
  await plugin.setup(host)
  await settle()
  const result = await host.rpcs.at(-1).handlers.addProvider({ providerID: "plain", baseURL: fixture.baseURL, apiKey: KEY })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(fixture.state.seenPaths, ["/v1/models"])
  assert.deepEqual(fixture.state.seenAuth, [`Bearer ${KEY}`])
})
