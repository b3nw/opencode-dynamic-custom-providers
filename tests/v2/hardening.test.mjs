// Regression tests for independent review findings R1-R5, R7, R8 and the adjacent minors.
// Each test names the review repro it covers. Fixtures are loopback-only with fake keys.
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import plugin from "../../packages/v2/dist/v2/server.js"
import { clearModelsDevCache } from "../../packages/v2/dist/v2/discover.js"
import { assertNoSecret, createHost, settle, startFixture, stubModelsDev, tempDir, toolContext, until } from "./helpers.mjs"

let restore
let fixture
const ENV_NAMES = ["OPENCODE_LOCAL_PROXY_API_KEY", "OPENCODE_LOCAL_AGENTBOUND_API_KEY", "OPENCODE_LOCAL_FRESH_API_KEY"]

beforeEach(async () => {
  clearModelsDevCache()
  restore = stubModelsDev({})
  fixture = await startFixture({ models: ["alpha"] })
})

afterEach(async () => {
  restore()
  await fixture.close()
  for (const name of ENV_NAMES) delete process.env[name]
})

async function boot(hostOptions = {}, options = {}) {
  const directory = hostOptions.directory ?? (await tempDir())
  const host = createHost({ ...hostOptions, directory })
  host.options = options
  const cleanup = await plugin.setup(host)
  await settle()
  await host.rpcs[0].handlers.status({})
  return { host, cleanup, directory }
}

const rpc = (host) => host.rpcs.at(-1).handlers
const tool = (host, name) => host.tools.find((t) => t.name === name)
const models = (host, id) => {
  const record = host.records().get(id)
  return record ? [...record.models.keys()].sort() : undefined
}
const exists = (file) => fs.stat(file).then(() => true, () => false)
const configFile = (directory) => path.join(directory, "opencode.jsonc")
const readConfig = async (directory) => JSON.parse(await fs.readFile(configFile(directory), "utf8"))
const origin = (url) => new URL(url).origin

// ── R1: agent-controlled endpoints never get ambient credentials ──

test("R1 review repro: agent tool with an env key for an unused ID and an unapproved origin contacts nothing and writes nothing", async () => {
  process.env.OPENCODE_LOCAL_AGENTBOUND_API_KEY = "not-an-sk-format-test-credential"
  const { host, directory } = await boot()
  const out = await tool(host, "add-provider").execute({ providerID: "agentbound", baseURL: fixture.baseURL }, toolContext())
  assert.match(out.content, /not an approved endpoint origin/)
  assert.match(out.content, /Nothing was contacted or saved/)
  assert.equal(fixture.state.seenAuth.length, 0, "no request at all to the agent-chosen origin")
  assert.equal(await exists(configFile(directory)), false)
  assert.equal(host.records().has("agentbound"), false)
})

test("R1: agent tool may add a provider on an already configured origin, unauthenticated, when no credential exists for the ID", async () => {
  const { host, directory } = await boot({ configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  const before = fixture.state.seenAuth.length
  const out = await tool(host, "add-provider").execute({ providerID: "fresh", baseURL: fixture.baseURL }, toolContext())
  assert.match(out.content, /Provider 'fresh' added with 1 model/)
  assert.deepEqual(fixture.state.seenAuth.slice(before), [null], "exactly one request and it carried no credential")
  assert.deepEqual(Object.keys((await readConfig(directory)).providers), ["fresh"])
})

test("R1: agent tool refuses a configured origin when an env or stored credential already exists for the new ID", async () => {
  for (const kind of ["env", "stored"]) {
    if (kind === "env") process.env.OPENCODE_LOCAL_FRESH_API_KEY = "ambient-env-credential-1234"
    const { host, directory } = await boot({
      configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } },
      credentials: kind === "stored" ? { fresh: { type: "key", key: "ambient-stored-credential-1234" } } : {},
    })
    const before = fixture.state.seenAuth.length
    const out = await tool(host, "add-provider").execute({ providerID: "fresh", baseURL: fixture.baseURL }, toolContext())
    assert.match(out.content, /Credentials already exist for 'fresh'/, kind)
    assert.equal(fixture.state.seenAuth.length, before, `${kind}: nothing contacted`)
    assert.equal(await exists(configFile(directory)), false, `${kind}: nothing written`)
    delete process.env.OPENCODE_LOCAL_FRESH_API_KEY
  }
})

test("R1: agent overwrite cannot move an existing provider (with stored credential) to another origin", async () => {
  const other = await startFixture({ models: ["evil"] })
  try {
    const directory = await tempDir()
    await fs.writeFile(configFile(directory), JSON.stringify({ providers: { proxy: { settings: { baseURL: fixture.baseURL } } } }))
    fixture.state.requireKey = "stored-credential-abc123"
    const { host } = await boot({
      directory,
      configFromFile: true,
      credentials: { proxy: { type: "key", key: "stored-credential-abc123" } },
    })
    assert.deepEqual(models(host, "proxy"), ["alpha"])
    const out = await tool(host, "add-provider").execute({ providerID: "proxy", baseURL: other.baseURL, overwrite: true }, toolContext())
    assert.match(out.content, /Changing the endpoint origin of 'proxy' needs user approval/)
    assert.equal(other.state.seenAuth.length, 0, "new origin never contacted")
    assert.equal((await readConfig(directory)).providers.proxy.settings.baseURL, fixture.baseURL, "config unchanged")
  } finally {
    await other.close()
  }
})

test("R1: agent same-origin overwrite authenticates with exactly the credential execution already sends there", async () => {
  const directory = await tempDir()
  await fs.writeFile(configFile(directory), JSON.stringify({ providers: { proxy: { settings: { baseURL: `${fixture.baseURL}/old` } } } }))
  fixture.state.requireKey = "stored-credential-abc123"
  const { host } = await boot({ directory, configFromFile: true, credentials: { proxy: { type: "key", key: "stored-credential-abc123" } } })
  const out = await tool(host, "add-provider").execute({ providerID: "proxy", baseURL: fixture.baseURL, overwrite: true }, toolContext())
  assert.match(out.content, /updated with 1 model/)
  assert.equal(fixture.state.seenAuth.at(-1), "Bearer stored-credential-abc123")
  assertNoSecret(out.content, "tool output", ["stored-credential-abc123"])
})

test("R1: plugin option agentOrigins approves an extra origin for the tool, still without credentials", async () => {
  const { host } = await boot({}, { agentOrigins: [origin(fixture.baseURL), "https://bad.example/path", "not a url"] })
  const out = await tool(host, "add-provider").execute({ providerID: "fresh", baseURL: fixture.baseURL }, toolContext())
  assert.match(out.content, /added with 1 model/)
  assert.deepEqual(fixture.state.seenAuth, [null])
})

test("R1: trusted RPC origin change with an existing credential requires re-entering the key; with a key only that key reaches the new origin", async () => {
  const other = await startFixture({ models: ["beta"] })
  try {
    const directory = await tempDir()
    await fs.writeFile(configFile(directory), JSON.stringify({ providers: { proxy: { settings: { baseURL: fixture.baseURL } } } }))
    fixture.state.requireKey = "stored-credential-abc123"
    const { host } = await boot({ directory, configFromFile: true, credentials: { proxy: { type: "key", key: "stored-credential-abc123" } } })
    let result = await rpc(host).addProvider({ providerID: "proxy", baseURL: other.baseURL, overwrite: true })
    assert.equal(result.code, "approval_required")
    assert.match(result.message, /enter the API key again/)
    assert.equal(other.state.seenAuth.length, 0)
    result = await rpc(host).addProvider({ providerID: "proxy", baseURL: other.baseURL, overwrite: true, apiKey: "new-origin-key-xyz789" })
    assert.equal(result.ok, true, result.message)
    assert.deepEqual(other.state.seenAuth, ["Bearer new-origin-key-xyz789"], "stored credential never sent to the new origin")
    assert.equal(result.credentialStored, true)
    assertNoSecret(result, "result", ["new-origin-key-xyz789", "stored-credential-abc123"])
  } finally {
    await other.close()
  }
})

test("minor: trusted RPC same-origin update without a key reuses the provider's active stored credential", async () => {
  const directory = await tempDir()
  await fs.writeFile(configFile(directory), JSON.stringify({ providers: { proxy: { settings: { baseURL: `${fixture.baseURL}/old` } } } }))
  fixture.state.requireKey = "stored-credential-abc123"
  const { host } = await boot({ directory, configFromFile: true, credentials: { proxy: { type: "key", key: "stored-credential-abc123" } } })
  const result = await rpc(host).addProvider({ providerID: "proxy", baseURL: fixture.baseURL, overwrite: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(fixture.state.seenAuth.at(-1), "Bearer stored-credential-abc123")
  // Existing providers switch when the host reloads the config; models were prepared for that source.
  assert.match(result.warnings.join("\n"), /when it reloads the config/)
  const requests = fixture.state.seenAuth.length
  await host.configReload()
  await until(async () => (await rpc(host).status({})).providers.find((p) => p.id === "proxy")?.baseURL === fixture.baseURL, 2000, "switch")
  await until(() => models(host, "proxy")?.join() === "alpha", 2000, "prepared inventory applied")
  assert.equal(fixture.state.seenAuth.length, requests, "prepared inventory applied without a second discovery")
})

test("R1: cross-origin redirects are not followed (no request, no credential to the other origin); same-origin redirects are", async () => {
  const other = await startFixture({ models: ["elsewhere"] })
  try {
    fixture.state.redirect = `${other.baseURL}/models`
    const { host, directory } = await boot()
    let result = await rpc(host).addProvider({ providerID: "redir", baseURL: fixture.baseURL, apiKey: "redirect-key-123456" })
    assert.equal(result.code, "discovery_failed")
    assert.match(result.message, /redirect to a different origin was not followed/)
    assert.equal(other.state.seenAuth.length, 0)
    assert.equal(await exists(configFile(directory)), false)
    // Same origin: /v0/models -> /v1/models keeps the credential on that origin.
    fixture.state.redirect = undefined
    const same = await startFixture({ models: ["moved"] })
    same.state.redirect = `${same.baseURL}/models`
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === `${same.baseURL.replace("/v1", "/v0")}/models`) return new Response(null, { status: 302, headers: { location: `${same.baseURL}/models` } })
      return original(input, init)
    }
    try {
      same.state.redirect = undefined
      result = await rpc(host).addProvider({ providerID: "moved", baseURL: same.baseURL.replace("/v1", "/v0"), apiKey: "redirect-key-123456" })
      assert.equal(result.ok, true, result.message)
      assert.deepEqual(same.state.seenAuth, ["Bearer redirect-key-123456"])
    } finally {
      globalThis.fetch = original
      await same.close()
    }
  } finally {
    await other.close()
  }
})

// ── R2: discovery and execution use the same connection; inventory is bound to it ──

test("R2 review repro: env key A plus stored key B -> discovery uses B (execution's active connection)", async () => {
  process.env.OPENCODE_LOCAL_PROXY_API_KEY = "env-account-a-key"
  fixture.state.modelsByKey = { "Bearer env-account-a-key": ["a-only"], "Bearer stored-account-b-key": ["b-only"] }
  const { host } = await boot({ configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  assert.deepEqual(models(host, "proxy"), ["a-only"], "env is the active connection before anything is stored")
  host.connect("proxy", { type: "key", key: "stored-account-b-key" })
  await until(() => models(host, "proxy")?.join() === "b-only", 2000, "re-discovery with the switched account")
  assert.equal(fixture.state.seenAuth.at(-1), "Bearer stored-account-b-key")
  const result = await rpc(host).refresh({ providerID: "proxy" })
  assert.equal(fixture.state.seenAuth.at(-1), "Bearer stored-account-b-key")
  assertNoSecret(result, "refresh", ["env-account-a-key", "stored-account-b-key"])
})

test("R2: account switch whose discovery fails removes the previous account's models instead of retaining them", async () => {
  fixture.state.modelsByKey = { "Bearer account-a-key-1234": ["a-only"] }
  const { host } = await boot({
    configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } },
    credentials: { proxy: { type: "key", key: "account-a-key-1234" } },
  })
  assert.deepEqual(models(host, "proxy"), ["a-only"])
  host.connect("proxy", { type: "key", key: "account-b-key-5678" })
  await until(() => models(host, "proxy")?.length === 0, 2000, "previous account inventory removed")
  const status = (await rpc(host).status({})).providers.find((p) => p.id === "proxy")
  assert.equal(status.models, 0)
  assert.match(status.lastError, /HTTP 401/)
  assertNoSecret(status, "status", ["account-a-key-1234", "account-b-key-5678"])
})

test("R2: without credential events, an explicit refresh after an account switch never keeps the old account's models", async () => {
  fixture.state.modelsByKey = { "Bearer account-a-key-1234": ["a-only"] }
  const { host } = await boot({
    events: false,
    configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } },
    credentials: { proxy: { type: "key", key: "account-a-key-1234" } },
  })
  host.connect("proxy", { type: "key", key: "account-b-key-5678" })
  const result = await rpc(host).refresh({})
  assert.equal(result.failures, 1)
  assert.match(result.errors[0], /previous models from another source or connection were removed/)
  assert.deepEqual(models(host, "proxy"), [])
})

test("R2: settings.apiKey plus a stored credential: discovery follows execution (stored) and stays bound to it", async () => {
  fixture.state.modelsByKey = { "Bearer settings-key-1234": ["settings-model"], "Bearer stored-key-5678": ["stored-model"] }
  const { host } = await boot({
    configProviders: { proxy: { settings: { baseURL: fixture.baseURL, apiKey: "settings-key-1234" } } },
    credentials: { proxy: { type: "key", key: "stored-key-5678" } },
  })
  assert.deepEqual(models(host, "proxy"), ["stored-model"])
  assert.equal(fixture.state.seenAuth.includes("Bearer settings-key-1234"), false)
})

// ── R3: session-added providers retire after config acknowledgement and obey config ──

async function addedViaRpc(extraHost = {}, options = {}) {
  const directory = await tempDir()
  const booted = await boot({ directory, configFromFile: true, ...extraHost }, options)
  const result = await rpc(booted.host).addProvider({ providerID: "added", baseURL: fixture.baseURL })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(models(booted.host, "added"), ["alpha"], "live before the config reload")
  return booted
}

async function editConfig(directory, edit) {
  const config = await readConfig(directory)
  edit(config)
  await fs.writeFile(configFile(directory), JSON.stringify(config, null, 2))
}

async function statusOf(host, id) {
  return (await rpc(host).status({})).providers.find((p) => p.id === id)
}

test("R3 review repro: RPC add -> config adopts it -> delete from config -> provider and models are gone", async () => {
  const { host, directory } = await addedViaRpc()
  assert.equal((await statusOf(host, "added")).pending, true)
  await host.configReload() // host adopts the written config
  await until(async () => (await statusOf(host, "added"))?.pending === undefined, 2000, "acknowledged")
  assert.deepEqual(models(host, "added"), ["alpha"], "still live from config after acknowledgement")
  await editConfig(directory, (config) => delete config.providers.added)
  await host.configReload()
  await until(async () => (await statusOf(host, "added")) === undefined, 2000, "status pruned")
  await until(() => !host.records().has("added"), 2000, "not resurrected")
  await host.provider.reload()
  assert.equal(host.records().has("added"), false, "not resurrected on later folds")
})

test("R3: deleting a session-added provider before the host acknowledged it also retires it", async () => {
  const { host, directory } = await addedViaRpc()
  await editConfig(directory, (config) => delete config.providers.added)
  await host.configReload()
  await until(async () => (await statusOf(host, "added")) === undefined, 2000, "retired")
  await until(() => !host.records().has("added"), 2000, "record removed")
})

test("R3: explicit config models or an incompatible package retire the injected inventory", async () => {
  for (const edit of [
    (p) => (p.models = { manual: {} }),
    (p) => (p.package = "@opencode/ai/providers/anthropic"),
  ]) {
    const { host, directory } = await addedViaRpc()
    await editConfig(directory, (config) => edit(config.providers.added))
    await host.configReload()
    await until(async () => (await statusOf(host, "added")) === undefined, 2000, "retired")
    await until(() => !(models(host, "added") ?? []).includes("alpha"), 2000, `no injected models after ${edit}`)
  }
})

test("R3: add-provider respects opt-out and native-discovery IDs instead of injecting them", async () => {
  const { host, directory } = await boot({ directory: await tempDir() }, { providers: { optout: { discover: false } } })
  let result = await rpc(host).addProvider({ providerID: "optout", baseURL: fixture.baseURL })
  assert.equal(result.code, "invalid")
  assert.match(result.message, /disabled/)
  result = await rpc(host).addProvider({ providerID: "ollama", baseURL: fixture.baseURL })
  assert.equal(result.code, "invalid")
  assert.equal(fixture.state.seenAuth.length, 0)
  assert.equal(await exists(configFile(directory)), false)
})

// ── R4: inventory is bound to its source ──

test("R4 review repro: changing a provider's URL re-discovers the new endpoint and never shows the old models", async () => {
  const other = await startFixture({ models: ["b"] })
  try {
    const directory = await tempDir()
    await fs.writeFile(configFile(directory), JSON.stringify({ providers: { proxy: { settings: { baseURL: fixture.baseURL } } } }))
    const { host } = await boot({ directory, configFromFile: true })
    assert.deepEqual(models(host, "proxy"), ["alpha"])
    await editConfig(directory, (config) => (config.providers.proxy.settings.baseURL = other.baseURL))
    await host.configReload()
    await until(() => models(host, "proxy")?.join() === "b", 2000, "new endpoint discovered")
    assert.equal(other.state.seenAuth.length, 1, "exactly one discovery for the new endpoint")
    assert.equal((await statusOf(host, "proxy")).baseURL, other.baseURL)
  } finally {
    await other.close()
  }
})

test("R4: a URL change to a failing endpoint does not keep the old endpoint's models", async () => {
  const other = await startFixture({ models: ["b"] })
  other.state.status = 503
  try {
    const directory = await tempDir()
    await fs.writeFile(configFile(directory), JSON.stringify({ providers: { proxy: { settings: { baseURL: fixture.baseURL } } } }))
    const { host } = await boot({ directory, configFromFile: true })
    await editConfig(directory, (config) => (config.providers.proxy.settings.baseURL = other.baseURL))
    await host.configReload()
    await until(async () => (await statusOf(host, "proxy"))?.lastError, 2000, "failure recorded")
    assert.deepEqual(models(host, "proxy"), [])
    assert.match((await statusOf(host, "proxy")).lastError, /HTTP 503/)
  } finally {
    await other.close()
  }
})

test("R4: removing and re-adding the same ID re-discovers; package changes are a new source", async () => {
  const directory = await tempDir()
  const entry = { settings: { baseURL: fixture.baseURL } }
  await fs.writeFile(configFile(directory), JSON.stringify({ providers: { proxy: entry } }))
  const { host } = await boot({ directory, configFromFile: true })
  assert.equal(fixture.state.seenAuth.length, 1)
  await editConfig(directory, (config) => delete config.providers.proxy)
  await host.configReload()
  await until(async () => (await rpc(host).status({})).providers.length === 0, 2000, "removed from status")
  await editConfig(directory, (config) => (config.providers.proxy = entry))
  await host.configReload()
  await until(() => models(host, "proxy")?.join() === "alpha", 2000, "re-added")
  assert.equal(fixture.state.seenAuth.length, 2, "re-added ID was discovered again")
  await editConfig(directory, (config) => (config.providers.proxy.package = "@ai-sdk/openai-compatible"))
  await host.configReload()
  await until(() => fixture.state.seenAuth.length === 3, 2000, "package change re-discovered")
})

// ── R5: lifecycle, cancellation and disposal ──

test("R5 review repro: disposing during in-flight discovery writes no config, stores no key and reloads nothing", async () => {
  const { host, cleanup, directory } = await boot()
  fixture.state.hold = true
  const reloadsBefore = host.calls.providerReload
  const inflight = rpc(host).addProvider({ providerID: "inflight", baseURL: fixture.baseURL, apiKey: "inflight-key-123456" })
  const queued = rpc(host).addProvider({ providerID: "queued", baseURL: fixture.baseURL })
  await until(() => fixture.state.held?.length === 1, 2000, "request in flight")
  const disposing = cleanup()
  const [first, second] = await Promise.all([inflight, queued])
  await disposing
  for (const release of fixture.state.held) release()
  await settle(50)
  assert.equal(first.ok, false)
  assert.equal(first.code, "cancelled")
  assert.equal(second.code, "cancelled", "queued work settles as cancelled")
  assert.equal(await exists(configFile(directory)), false)
  assert.deepEqual(host.calls.connectKey, [])
  assert.equal(host.calls.providerReload, reloadsBefore, "no reload after disposal")
  assert.equal(fixture.state.closed, 1, "the in-flight request was aborted")
  const after = await rpc(host).addProvider({ providerID: "late", baseURL: fixture.baseURL })
  assert.equal(after.code, "cancelled", "no admission after disposal")
  assert.equal(await exists(configFile(directory)), false)
})

test("R5: an RPC client abort or a tool-call abort cancels discovery before anything is written", async () => {
  const { host, directory } = await boot({ configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  fixture.state.hold = true
  const controller = new AbortController()
  const pendingRpc = rpc(host).addProvider({ providerID: "aborted", baseURL: fixture.baseURL }, { signal: controller.signal })
  await until(() => fixture.state.held?.length === 1, 2000, "rpc request in flight")
  controller.abort()
  assert.equal((await pendingRpc).code, "cancelled")

  const toolController = new AbortController()
  const pendingTool = tool(host, "add-provider").execute({ providerID: "toolabort", baseURL: fixture.baseURL }, toolContext(toolController.signal))
  await until(() => fixture.state.held?.length === 2, 2000, "tool request in flight")
  toolController.abort()
  assert.match((await pendingTool).content, /Cancelled/)

  const refreshController = new AbortController()
  const pendingRefresh = rpc(host).refresh({}, { signal: refreshController.signal })
  await until(() => fixture.state.held?.length === 3, 2000, "refresh in flight")
  refreshController.abort()
  const refreshed = await pendingRefresh
  assert.equal(refreshed.cancelled, true)
  for (const release of fixture.state.held) release()
  await settle(50)
  assert.equal(await exists(configFile(directory)), false)
  assert.deepEqual(models(host, "proxy"), ["alpha"], "aborted refresh changed nothing")
})

test("R5: repeated generations on one host: a disposed generation's transforms and timers have no effect", async () => {
  const directory = await tempDir()
  const host = createHost({ directory, configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  const first = await plugin.setup(host)
  await settle()
  await host.rpcs[0].handlers.status({})
  assert.deepEqual(models(host, "proxy"), ["alpha"])
  await first()
  fixture.state.models = ["second-generation"]
  // The fake host keeps old transforms registered; the disposed generation must be inert.
  const second = await plugin.setup(host)
  await settle()
  await host.rpcs[1].handlers.status({})
  assert.deepEqual(models(host, "proxy"), ["second-generation"])
  assert.equal((await host.rpcs[0].handlers.refresh({})).cancelled, true)
  assert.deepEqual(models(host, "proxy"), ["second-generation"])
  await second()
})

// ── R7: exact-secret redaction, no remote bodies ──

test("R7 review repro: an error body echoing a non-sk key (raw, encoded, punctuated) never reaches RPC, status or tool output", async () => {
  const secrets = ["arbitraryCredentialValue987654321", "p@ss:word/with+punct=1", "  spaced-key-value-42  "]
  const { host } = await boot({ configProviders: { proxy: { settings: { baseURL: fixture.baseURL, apiKey: secrets[0] } } } })
  for (const secret of secrets) {
    for (const echo of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), `{"error":"bad key ${JSON.stringify(secret)}"}`]) {
      fixture.state.echo = echo
      const added = await rpc(host).addProvider({ providerID: "echo", baseURL: fixture.baseURL, apiKey: secret })
      assert.equal(added.code, "discovery_failed")
      assert.match(added.message, /HTTP 401 Unauthorized/)
      assertNoSecret(added, "add result", [secret.trim()])
    }
  }
  fixture.state.echo = secrets[0]
  const refreshed = await rpc(host).refresh({})
  const status = await rpc(host).status({})
  const toolOut = await tool(host, "refresh-models").execute({}, toolContext())
  for (const [label, value] of [["refresh", refreshed], ["status", status], ["tool", toolOut.content]]) assertNoSecret(value, label, [secrets[0]])
})

test("R7: credential-store failures are reported without the key or host error text", async () => {
  const { host } = await boot({ connectFails: true })
  const result = await rpc(host).addProvider({ providerID: "added", baseURL: fixture.baseURL, apiKey: "store-failure-key-abcdef" })
  assert.equal(result.ok, true)
  assert.match(result.warnings[0], /could not be stored \(unexpected error\)/)
  assertNoSecret(result, "result", ["store-failure-key-abcdef"])
})

// ── R8: no query/fragment credentials in persisted URLs ──

test("R8 review repro: base URLs with query strings or fragments are rejected before any request or write", async () => {
  const { host, directory } = await boot()
  for (const suffix of ["?api_key=query-secret-12345", "?token=abc123456", "?harmless=1", "?", "#frag"]) {
    const result = await rpc(host).addProvider({ providerID: "querysecret", baseURL: `${fixture.baseURL}${suffix}` })
    assert.equal(result.code, "invalid", suffix)
    assertNoSecret(result, "result", ["query-secret-12345", "abc123456"])
  }
  assert.equal(fixture.state.seenAuth.length, 0)
  assert.equal(await exists(configFile(directory)), false)
})

test("R8: user-configured query parameters are passed to discovery but never shown in status", async () => {
  const { host } = await boot({ configProviders: { proxy: { settings: { baseURL: `${fixture.baseURL}?api-version=2024-query-value` } } } })
  assert.deepEqual(models(host, "proxy"), ["alpha"])
  assert.match(fixture.state.seenPaths.at(-1), /api-version=2024-query-value/)
  const status = await rpc(host).status({})
  assert.equal(status.providers[0].baseURL, fixture.baseURL)
  assertNoSecret(status, "status", ["2024-query-value"])
})

// ── minor: status only lists live providers ──

test("minor: status no longer lists providers removed from config", async () => {
  const config = { proxy: { settings: { baseURL: fixture.baseURL } } }
  const { host } = await boot({ configProviders: config })
  assert.equal((await rpc(host).status({})).providers.length, 1)
  delete config.proxy
  await host.provider.reload()
  await settle()
  assert.deepEqual((await rpc(host).status({})).providers, [])
})
