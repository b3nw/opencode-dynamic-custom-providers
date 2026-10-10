// Regression tests for pass-4 review finding P4-M1: a config layer takes the provider over with
// explicit model IDs this plugin also discovered while the final project-file read (after the
// post-save injection-free ownership fold) is awaited, and the host folds that change before the
// read returns. Corrective pass 5. Fixtures are loopback-only with fake keys.
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { syncBuiltinESMExports } from "node:module"
import plugin from "../../packages/v2/dist/v2/server.js"
import { clearModelsDevCache } from "../../packages/v2/dist/v2/discover.js"
import { createHost, settle, startFixture, stubModelsDev, tempDir } from "./helpers.mjs"

const NATIVE = "@opencode/ai/providers/openai-compatible"
const KEY = "fake-pass5-key-012345"

let restore
let fixture

beforeEach(async () => {
  clearModelsDevCache()
  restore = stubModelsDev({})
  fixture = await startFixture({ models: ["alpha", "beta"] })
})

afterEach(async () => {
  restore()
  await fixture.close()
})

const rpc = (host) => host.rpcs.at(-1).handlers
const configFile = (directory) => path.join(directory, "opencode.jsonc")
const readSaved = async (directory) => JSON.parse(await fs.readFile(configFile(directory), "utf8"))
const managed = async (host, id) => (await rpc(host).status({})).providers.some((p) => p.id === id)

async function boot({ existing, options = {} }) {
  const directory = await tempDir()
  const id = existing ? "proxy" : "newkey"
  const layered = existing ? { [id]: { package: NATIVE, settings: { baseURL: fixture.baseURL } } } : {}
  if (existing) await fs.writeFile(configFile(directory), JSON.stringify({ providers: layered }, null, 2))
  const host = createHost({ directory, configProviders: layered })
  host.options = options
  const cleanup = await plugin.setup(host)
  await settle()
  await rpc(host).status({})
  return { host, cleanup, directory, layered, id }
}

/**
 * Holds the project-file read that follows the post-save injection-free ownership fold (the 2nd
 * post-save model reload for a new provider, whose 1st is the activation reload; the 1st for an
 * existing provider's overwrite). The read returns the actual file bytes; before they are
 * returned, `change` edits another config layer, emits config.updated and the host folds it.
 */
function duringFinalRead(host, directory, id, after, change) {
  const state = { changed: false, trace: [] }
  const file = configFile(directory)
  let folds = 0
  let armed = false
  const modelReload = host.model.reload
  host.model.reload = async () => {
    await modelReload()
    const saved = await read(file, "utf8").then((text) => text.includes(`"${id}"`), () => false)
    if (saved && ++folds === after) armed = true
  }
  const read = fs.readFile
  fs.readFile = async (...args) => {
    const data = await read(...args)
    if (armed && !state.changed && String(args[0]) === file) {
      state.changed = true
      await change()
      host.emit({ type: "config.updated", data: {} })
      await host.provider.reload()
      state.trace.push("external-fold")
    }
    return data
  }
  syncBuiltinESMExports()
  const connect = host.integration.connect.key
  host.integration.connect.key = async (input) => {
    state.trace.push("connect.key")
    return connect(input)
  }
  state.restore = () => {
    fs.readFile = read
    syncBuiltinESMExports()
  }
  return state
}

async function run({ existing, layer, apiKey = KEY, options, cancel = false }) {
  const booted = await boot({ existing, options })
  const { host, directory, layered, id } = booted
  const controller = new AbortController()
  const state = duringFinalRead(host, directory, id, existing ? 1 : 2, async () => {
    layered[id] = layer()
    if (cancel) controller.abort()
  })
  try {
    const result = await rpc(host).addProvider(
      { providerID: id, baseURL: fixture.baseURL, overwrite: existing, ...(apiKey ? { apiKey } : {}) },
      { signal: controller.signal },
    )
    return { ...booted, state, result }
  } finally {
    state.restore()
  }
}

const savedEntry = () => ({ package: NATIVE, settings: { baseURL: fixture.baseURL } })
const overlap = () => ({ ...savedEntry(), models: { alpha: { name: "USER OWNED" } } })

for (const existing of [false, true]) {
  const kind = existing ? "existing provider" : "new provider"

  for (const withKey of [true, false]) {
    test(`P4-M1: ${kind}, overlapping explicit model folded during the final file read -> conflict${withKey ? ", key not stored" : " (no key)"}`, async () => {
      const { host, cleanup, directory, state, result, id } = await run({ existing, layer: overlap, apiKey: withKey ? KEY : undefined })
      assert.equal(state.changed, true, "the takeover ran during the final read")
      assert.deepEqual(state.trace, ["external-fold"], "no credential action after the takeover")
      assert.equal(result.ok, false, JSON.stringify(result))
      assert.equal(result.code, "conflict")
      assert.match(result.message, /another config layer took it over/)
      assert.match(result.message, /API key was not stored/)
      assert.equal(result.credentialStored, undefined)
      assert.deepEqual(host.calls.connectKey, [])
      // The saved project entry stays exactly as written.
      assert.deepEqual(await readSaved(directory), { providers: { [id]: savedEntry() } })
      await settle(50)
      assert.equal(await managed(host, id), false, "discovered inventory retired")
      await host.provider.reload()
      assert.deepEqual([...host.records().get(id).models.keys()], ["alpha"], "only the layer-owned model remains")
      await cleanup()
    })
  }

  test(`P4-M1: ${kind}, cancelled during the final file read -> cancelled, key not stored`, async () => {
    const { host, cleanup, state, result } = await run({ existing, layer: overlap, cancel: true })
    assert.equal(state.changed, true)
    assert.equal(result.code, "cancelled", JSON.stringify(result))
    assert.deepEqual(host.calls.connectKey, [])
    await cleanup()
  })

  test(`P4-M1 control: ${kind}, unchanged layer entry folded during the final file read stores the key`, async () => {
    const { host, cleanup, state, result, id } = await run({ existing, layer: savedEntry })
    assert.deepEqual(state.trace, ["external-fold", "connect.key"])
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.credentialStored, true)
    assert.equal(host.calls.connectKey.length, 1)
    await settle(50)
    assert.equal(await managed(host, id), true)
    await host.provider.reload()
    assert.deepEqual([...host.records().get(id).models.keys()].sort(), ["alpha", "beta"])
    await cleanup()
  })

  test(`P4-M1 control: ${kind}, discover:true keeps an overlapping explicit model folded during the read managed; key stored`, async () => {
    const { host, cleanup, state, result, id } = await run({ existing, layer: overlap, options: { providers: { [existing ? "proxy" : "newkey"]: { discover: true } } } })
    assert.deepEqual(state.trace, ["external-fold", "connect.key"])
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.credentialStored, true)
    await settle(50)
    assert.equal(await managed(host, id), true)
    await host.provider.reload()
    assert.deepEqual([...host.records().get(id).models.keys()].sort(), ["alpha", "beta"])
    await cleanup()
  })
}

test("P4-M1: a takeover folded while the key action is in flight is still applied before injections return", async () => {
  // After the last validation the key is issued (accepted residual: not atomic with later
  // changes). The fold it overlapped must not be lost: the discovered inventory is retired.
  const { host, cleanup, layered } = await boot({ existing: false })
  const connect = host.integration.connect.key
  host.integration.connect.key = async (input) => {
    layered.newkey = overlap()
    host.emit({ type: "config.updated", data: {} })
    await host.provider.reload()
    return connect(input)
  }
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: KEY })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(host.calls.connectKey.length, 1)
  await settle(50)
  assert.equal(await managed(host, "newkey"), false, "takeover observed, inventory retired")
  await host.provider.reload()
  assert.deepEqual([...host.records().get("newkey").models.keys()], ["alpha"])
  await cleanup()
})
