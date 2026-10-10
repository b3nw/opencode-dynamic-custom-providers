import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import plugin, { id as pluginID } from "../../packages/v2/dist/v2/server.js"
import { DynamicProvidersRpc, RPC_ID } from "../../packages/v2/dist/v2/rpc.js"
import { clearModelsDevCache } from "../../packages/v2/dist/v2/discover.js"
import {
  assertNoSecret,
  createHost,
  decodeModels,
  decodeProvider,
  settle,
  startFixture,
  stubModelsDev,
  tempDir,
} from "./helpers.mjs"

const NATIVE = "@opencode/ai/providers/openai-compatible"
let restore
let fixture

beforeEach(async () => {
  clearModelsDevCache()
  restore = stubModelsDev({
    openai: { id: "openai", name: "OpenAI", models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o", release_date: "2024-05-13", attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 }, modalities: { input: ["text", "image"], output: ["text"] } } } },
  })
  fixture = await startFixture({ models: ["fixture-a", "vendor/gpt-4o"] })
})

afterEach(async () => {
  restore()
  await fixture.close()
  delete process.env.OPENCODE_LOCAL_PROXY_API_KEY
})

async function boot(hostOptions, options = {}) {
  const directory = hostOptions.directory ?? (await tempDir())
  const host = createHost({ ...hostOptions, directory })
  host.options = options
  const cleanup = await plugin.setup(host)
  // Startup discovery is detached (setTimeout 0); it runs through the serialized queue,
  // so a status call queued after it resolves once startup discovery has finished.
  await settle()
  await host.rpcs[0].handlers.status({})
  return { host, cleanup, directory }
}

function tool(host, name) {
  const found = host.tools.find((t) => t.name === name)
  assert.ok(found, `tool ${name} registered`)
  return found
}

function rpc(host) {
  assert.equal(host.rpcs.length, 1)
  return host.rpcs[0].handlers
}

function models(host, id) {
  const record = host.records().get(id)
  return record ? [...record.models.keys()].sort() : undefined
}

test("default export matches the V2 loader contract { id, setup } and is not a V1 { id, server }", () => {
  assert.equal(typeof plugin.id, "string")
  assert.equal(plugin.id, pluginID)
  assert.equal(pluginID, "opencode-dynamic-custom-providers-v2")
  assert.equal(typeof plugin.setup, "function")
  assert.equal("server" in plugin, false)
  assert.equal(DynamicProvidersRpc.id, RPC_ID)
  assert.deepEqual(Object.keys(DynamicProvidersRpc.methods).sort(), ["addProvider", "refresh", "status"])
})

test("RPC and tool schemas avoid JSON Schema keywords the 2.0.21 host rejects (pattern)", async () => {
  // Regression: the real host answered rpc.invalid_input "Pattern encountered while patterns is set to error".
  assert.equal(JSON.stringify(DynamicProvidersRpc).includes('"pattern"'), false)
  const { host } = await boot({})
  for (const t of host.tools) assert.equal(JSON.stringify(t.input).includes('"pattern"'), false, t.name)
})

test("startup discovers eligible config providers once and produces schema-valid native models", async () => {
  const { host } = await boot({
    configProviders: { proxy: { name: "Proxy", settings: { baseURL: fixture.baseURL } } },
  })
  assert.deepEqual(models(host, "proxy"), ["fixture-a", "vendor/gpt-4o"])
  const record = host.records().get("proxy")
  decodeProvider(record)
  const decoded = decodeModels(record)
  const enriched = decoded.find((m) => m.id === "vendor/gpt-4o")
  assert.equal(enriched.capabilities.tools, true)
  assert.equal(enriched.limit.context, 128000)
  assert.deepEqual(enriched.cost, [{ input: 2.5, output: 10, cache: { read: 0, write: 0 } }])
  const unknown = decoded.find((m) => m.id === "fixture-a")
  assert.equal(unknown.capabilities.tools, false)
  assert.equal(record.provider.package, NATIVE)
  assert.equal(record.provider.settings.baseURL, fixture.baseURL)
  // Exactly one models request at startup; nothing polls afterwards.
  const before = fixture.state.seenAuth.length
  assert.equal(before, 1)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(fixture.state.seenAuth.length, before)
})

test("skips explicit-model, native-discovery, incompatible-package and opted-out providers", async () => {
  const { host } = await boot(
    {
      configProviders: {
        pinned: { settings: { baseURL: fixture.baseURL }, models: { manual: {} } },
        ollama: { settings: { baseURL: fixture.baseURL } },
        anthropicish: { package: "@opencode/ai/providers/anthropic", settings: { baseURL: fixture.baseURL } },
        optedout: { settings: { baseURL: fixture.baseURL } },
        nourl: { settings: {} },
        badurl: { settings: { baseURL: "ftp://example.invalid" } },
      },
    },
    { providers: { optedout: { discover: false } } },
  )
  assert.deepEqual(models(host, "pinned"), ["manual"])
  assert.deepEqual(models(host, "ollama"), [])
  assert.deepEqual(models(host, "anthropicish"), [])
  assert.deepEqual(models(host, "optedout"), [])
  assert.equal(fixture.state.seenAuth.length, 0, "no discovery requests for ineligible providers")
  const status = await rpc(host).status({})
  assert.deepEqual(status.providers, [])
})

test("explicit opt-in adds discovered models alongside explicit ones; aisdk package specifier is compatible", async () => {
  const { host } = await boot(
    {
      configProviders: {
        pinned: { package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: fixture.baseURL }, models: { manual: {} } },
      },
    },
    { providers: { pinned: { discover: true, displayStyle: "name" } } },
  )
  assert.deepEqual(models(host, "pinned"), ["fixture-a", "manual", "vendor/gpt-4o"])
  assert.equal(host.records().get("pinned").models.get("vendor/gpt-4o").name, "GPT-4o")
})

test("manual config model overrides keep precedence over discovered metadata", async () => {
  const { host } = await boot(
    {
      configProviders: {
        proxy: {
          settings: { baseURL: fixture.baseURL },
          models: { "vendor/gpt-4o": { name: "My Override", limit: { output: 1234 } }, "fixture-a": { disabled: true } },
        },
      },
    },
    { providers: { proxy: { discover: true } } },
  )
  const final = host.models()
  assert.equal(final.get("proxy/vendor/gpt-4o").name, "My Override")
  assert.equal(final.get("proxy/vendor/gpt-4o").limit.output, 1234)
  assert.equal(final.get("proxy/vendor/gpt-4o").limit.context, 128000, "discovered fields not overridden stay")
  assert.equal(final.get("proxy/vendor/gpt-4o").capabilities.tools, true)
  assert.equal(final.get("proxy/fixture-a").enabled, false)
})

test("behaviour does not depend on fold order relative to the config provider plugin", async () => {
  for (const configOrder of ["after", "before"]) {
    const { host } = await boot({ configOrder, configProviders: { proxy: { settings: { baseURL: fixture.baseURL } }, pinned: { settings: { baseURL: fixture.baseURL }, models: { manual: {} } } } })
    assert.deepEqual(models(host, "proxy"), ["fixture-a", "vendor/gpt-4o"], configOrder)
    assert.deepEqual(models(host, "pinned"), ["manual"], configOrder)
    fixture.state.models = ["only-new"]
    await rpc(host).refresh({})
    assert.deepEqual(models(host, "proxy"), ["only-new"], configOrder)
    fixture.state.models = ["fixture-a", "vendor/gpt-4o"]
  }
})

test("providers removed from config disappear after the next fold; newly configured ones are discovered once", async () => {
  const config = { proxy: { settings: { baseURL: fixture.baseURL } } }
  const { host } = await boot({ configProviders: config })
  assert.deepEqual(models(host, "proxy"), ["fixture-a", "vendor/gpt-4o"])
  delete config.proxy
  config.later = { settings: { baseURL: fixture.baseURL } }
  const before = fixture.state.seenAuth.length
  await host.provider.reload() // simulates core reacting to config.updated
  await settle()
  await rpc(host).status({})
  await settle()
  await host.provider.reload()
  assert.equal(host.records().has("proxy") && models(host, "proxy").length > 0, false, "removed provider not resurrected")
  assert.deepEqual(models(host, "later"), ["fixture-a", "vendor/gpt-4o"])
  assert.equal(fixture.state.seenAuth.length - before, 1, "exactly one discovery for the new provider")
})

test("refresh removes stale IDs, adds new ones, and retains last-good inventory on outage and empty results", async () => {
  const { host } = await boot({ configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  const refresh = tool(host, "refresh-models")
  assert.deepEqual(models(host, "proxy"), ["fixture-a", "vendor/gpt-4o"])

  fixture.state.models = ["fixture-b", "vendor/gpt-4o"]
  let out = await refresh.execute({}, {})
  assert.match(out.content, /Reloaded 2 model\(s\) from 1 provider/)
  assert.deepEqual(models(host, "proxy"), ["fixture-b", "vendor/gpt-4o"])

  fixture.state.status = 503
  out = await refresh.execute({}, {})
  assert.match(out.content, /failure/)
  assert.match(out.content, /keeping 2 previous model/)
  assert.deepEqual(models(host, "proxy"), ["fixture-b", "vendor/gpt-4o"])

  fixture.state.status = 200
  fixture.state.models = []
  out = await refresh.execute({}, {})
  assert.match(out.content, /returned 0 models \(keeping previous models\)/)
  assert.deepEqual(models(host, "proxy"), ["fixture-b", "vendor/gpt-4o"])

  // Replaying the fold (e.g. an unrelated reload) keeps the snapshot stable.
  await host.provider.reload()
  assert.deepEqual(models(host, "proxy"), ["fixture-b", "vendor/gpt-4o"])

  const status = await rpc(host).status({})
  assert.equal(status.providers[0].models, 2)
  assert.match(status.providers[0].lastError, /0 models/)
})

test("refresh via RPC targets a single provider and reports ineligible IDs", async () => {
  const other = await startFixture({ models: ["other-1"] })
  try {
    const { host } = await boot({
      configProviders: {
        proxy: { settings: { baseURL: fixture.baseURL } },
        second: { settings: { baseURL: other.baseURL } },
      },
    })
    fixture.state.models = ["changed"]
    other.state.models = ["other-2"]
    const result = await rpc(host).refresh({ providerID: "second" })
    assert.deepEqual(result.updatedProviderIds, ["second"])
    assert.deepEqual(models(host, "second"), ["other-2"])
    assert.deepEqual(models(host, "proxy"), ["fixture-a", "vendor/gpt-4o"])
    const missing = await rpc(host).refresh({ providerID: "nope" })
    assert.equal(missing.failures, 1)
    assert.match(missing.errors[0], /not eligible/)
  } finally {
    await other.close()
  }
})

test("discovery authenticates exactly like 2.0.21 execution: active connection (newest stored, then env), then settings.apiKey", async () => {
  const cases = [
    { name: "settings + stored", settings: "sk-test-settings", env: undefined, stored: "sk-test-stored", expect: "sk-test-stored" },
    { name: "env + stored", settings: undefined, env: "sk-test-env", stored: "sk-test-stored", expect: "sk-test-stored" },
    { name: "env + settings", settings: "sk-test-settings", env: "sk-test-env", stored: undefined, expect: "sk-test-env" },
    { name: "env only", settings: undefined, env: "sk-test-env", stored: undefined, expect: "sk-test-env" },
    { name: "settings only", settings: "sk-test-settings", env: undefined, stored: undefined, expect: "sk-test-settings" },
  ]
  for (const item of cases) {
    if (item.env) process.env.OPENCODE_LOCAL_PROXY_API_KEY = item.env
    else delete process.env.OPENCODE_LOCAL_PROXY_API_KEY
    fixture.state.requireKey = item.expect
    const { host, cleanup } = await boot({
      configProviders: { proxy: { settings: { baseURL: fixture.baseURL, ...(item.settings ? { apiKey: item.settings } : {}) } } },
      credentials: item.stored ? { proxy: { type: "key", key: item.stored } } : {},
    })
    assert.deepEqual(models(host, "proxy"), ["fixture-a", "vendor/gpt-4o"], item.name)
    assert.equal(fixture.state.seenAuth.at(-1), `Bearer ${item.expect}`, item.name)
    assertNoSecret(await rpc(host).status({}), "status")
    assertNoSecret(await rpc(host).refresh({}), "refresh")
    assertNoSecret((await tool(host, "refresh-models").execute({}, {})).content, "tool output")
    await cleanup()
  }
})

test("OAuth connections are rejected for discovery rather than used as API keys", async () => {
  const { host } = await boot({
    configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } },
    credentials: { proxy: { type: "oauth", access: "sk-test-oauth-token", refresh: "r", expires: 0, methodID: "m" } },
  })
  assert.equal(models(host, "proxy").length, 0)
  const result = await rpc(host).refresh({})
  assert.equal(result.failures, 1)
  assert.match(result.errors[0], /OAuth connection/)
  assert.equal(fixture.state.seenAuth.some((value) => value && value.includes("sk-test-oauth")), false)
  assertNoSecret(result)
})

test("integration transform registers key and legacy env methods for managed providers without clobbering config env", async () => {
  const { host } = await boot({ configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  const methods = host.integrations().get("proxy").methods
  assert.ok(methods.some((m) => m.type === "key"))
  assert.deepEqual(methods.find((m) => m.type === "env"), { type: "env", names: ["OPENCODE_LOCAL_PROXY_API_KEY"] })
})

test("add-provider via RPC: discovers with the key, persists secret-free config, stores key via integration", async () => {
  fixture.state.requireKey = "sk-test-added-key"
  const directory = await tempDir()
  await fs.writeFile(path.join(directory, "opencode.jsonc"), '{\n  // keep me\n  "model": "x/y"\n}\n')
  const { host } = await boot({ directory })
  const result = await rpc(host).addProvider({ providerID: "added", baseURL: `${fixture.baseURL}/`, apiKey: "sk-test-added-key" })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.modelCount, 2)
  assert.equal(result.credentialStored, true)
  assert.equal(result.configPath, path.join(directory, "opencode.jsonc"))
  assertNoSecret(result, "add result")

  const text = await fs.readFile(path.join(directory, "opencode.jsonc"), "utf8")
  assert.match(text, /\/\/ keep me/)
  assert.equal(text.includes("sk-test"), false, "secret never written to config")
  assert.match(text, /"baseURL": "http:\/\/127\.0\.0\.1:\d+\/v1"/)
  assert.match(text, new RegExp(`"package": "${NATIVE.replaceAll("/", "\\/")}"`))
  assert.deepEqual(await fs.readdir(directory), ["opencode.jsonc"])

  assert.deepEqual(host.calls.connectKey, [{ integrationID: "added" }])
  assert.deepEqual(host.stored.added, { type: "key", key: "sk-test-added-key" })
  // Live before config reload: pending provider is injected and enabled.
  assert.deepEqual(models(host, "added"), ["fixture-a", "vendor/gpt-4o"])
  assert.equal(host.records().get("added").provider.activation, "enabled")
  decodeModels(host.records().get("added"))
})

test("add-provider duplicates require overwrite; overwrite updates in place; invalid input never writes", async () => {
  const directory = await tempDir()
  const { host } = await boot({ directory, configProviders: { builtin: { settings: {} } } })
  const add = rpc(host).addProvider

  let result = await add({ providerID: "builtin", baseURL: fixture.baseURL })
  assert.equal(result.ok, false)
  assert.equal(result.code, "duplicate")

  result = await add({ providerID: "fresh", baseURL: fixture.baseURL })
  assert.equal(result.ok, true)
  result = await add({ providerID: "fresh", baseURL: fixture.baseURL })
  assert.equal(result.code, "duplicate")
  result = await add({ providerID: "fresh", baseURL: fixture.baseURL, overwrite: true })
  assert.equal(result.ok, true)
  assert.match(result.message, /updated/)

  for (const bad of [
    { providerID: "has space", baseURL: fixture.baseURL },
    { providerID: "x", baseURL: "ftp://nope" },
    { providerID: "x", baseURL: "http://user:sk-test-inurl@127.0.0.1:1/v1" },
    { providerID: "", baseURL: fixture.baseURL },
    "not-an-object",
  ]) {
    const out = await add(bad)
    assert.equal(out.ok, false)
    assert.equal(out.code, "invalid")
    assertNoSecret(out)
  }
  const ids = Object.keys(JSON.parse(await fs.readFile(path.join(directory, "opencode.jsonc"), "utf8")).providers)
  assert.deepEqual(ids, ["fresh"])
})

test("add-provider discovery failure or empty inventory persists nothing", async () => {
  const directory = await tempDir()
  const { host } = await boot({ directory })
  fixture.state.status = 500
  let result = await rpc(host).addProvider({ providerID: "down", baseURL: fixture.baseURL })
  assert.equal(result.code, "discovery_failed")
  fixture.state.status = 200
  fixture.state.models = []
  result = await rpc(host).addProvider({ providerID: "empty", baseURL: fixture.baseURL })
  assert.equal(result.code, "discovery_failed")
  assert.deepEqual(await fs.readdir(directory), [])
})

test("add-provider keeps the secret out of config when the credential store fails", async () => {
  const directory = await tempDir()
  const { host } = await boot({ directory, connectFails: true })
  const result = await rpc(host).addProvider({ providerID: "added", baseURL: fixture.baseURL, apiKey: "sk-test-fallback" })
  assert.equal(result.ok, true)
  assert.equal(result.credentialStored, false)
  assert.match(result.warnings[0], /could not be stored/)
  assertNoSecret(result)
  assert.equal((await fs.readFile(path.join(directory, "opencode.jsonc"), "utf8")).includes("sk-test"), false)
})

test("add-provider tool never accepts API keys and refuses malformed config", async () => {
  const directory = await tempDir()
  await fs.writeFile(path.join(directory, "opencode.json"), "{ broken")
  const { host } = await boot({ directory })
  const add = tool(host, "add-provider")
  assert.equal("apiKey" in add.input.properties, false)
  assert.equal(add.input.additionalProperties, false)
  const out = await add.execute({ providerID: "x", baseURL: fixture.baseURL, apiKey: "sk-test-tool" }, {})
  assert.match(out.content, /malformed/)
  assert.equal(await fs.readFile(path.join(directory, "opencode.json"), "utf8"), "{ broken")
  assertNoSecret(out.content)
  assert.equal(fixture.state.seenAuth.includes("Bearer sk-test-tool"), false)
})

test("tool names satisfy core's registration rule and results use { content }", async () => {
  const { host } = await boot({})
  assert.deepEqual(host.tools.map((t) => t.name).sort(), ["add-provider", "refresh-models"])
  for (const t of host.tools) {
    assert.match(t.name, /^[A-Za-z0-9_-]{1,128}$/)
    assert.equal(typeof t.description, "string")
    assert.equal(t.input.type, "object")
  }
  const out = await tool(host, "refresh-models").execute({}, {})
  assert.equal(typeof out.content, "string")
  assert.match(out.content, /No dynamic providers configured/)
})

test("concurrent refresh and add calls are serialized without lost updates", async () => {
  const directory = await tempDir()
  const { host } = await boot({ directory, configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  const handlers = rpc(host)
  const results = await Promise.all([
    handlers.refresh({}),
    handlers.addProvider({ providerID: "a1", baseURL: fixture.baseURL }),
    handlers.addProvider({ providerID: "a2", baseURL: fixture.baseURL }),
    handlers.refresh({}),
  ])
  assert.equal(results[1].ok, true)
  assert.equal(results[2].ok, true)
  const ids = Object.keys(JSON.parse(await fs.readFile(path.join(directory, "opencode.jsonc"), "utf8")).providers).sort()
  assert.deepEqual(ids, ["a1", "a2"])
})

test("cleanup stops the detached startup discovery and later reloads", async () => {
  const directory = await tempDir()
  const host = createHost({ directory, configProviders: { proxy: { settings: { baseURL: fixture.baseURL } } } })
  const cleanup = await plugin.setup(host)
  await cleanup()
  await settle()
  assert.equal(fixture.state.seenAuth.length, 0)
  assert.deepEqual(models(host, "proxy"), [])
})

test("repeated setup generations register exactly one tool pair and one RPC handler each", async () => {
  for (let i = 0; i < 3; i++) {
    const { host, cleanup } = await boot({})
    assert.equal(host.tools.length, 2)
    assert.equal(host.rpcs.length, 1)
    await cleanup()
  }
})
