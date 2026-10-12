// Regression tests for pass-3 review findings P3-M2a / P3-M2b: changes that land while the
// post-save ownership probe (two host reloads) is in flight, before the key would be stored.
// Corrective pass 4. Fixtures are loopback-only with fake keys.
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import plugin from "../../packages/v2/dist/v2/server.js"
import { clearModelsDevCache } from "../../packages/v2/dist/v2/discover.js"
import { createHost, settle, startFixture, stubModelsDev, tempDir } from "./helpers.mjs"

const NATIVE = "@opencode/ai/providers/openai-compatible"
const KEY = "fake-pass4-key-012345"

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

async function boot({ options = {}, project, layered = {} } = {}) {
  const directory = await tempDir()
  if (project) await fs.writeFile(configFile(directory), JSON.stringify({ providers: project }, null, 2))
  const host = createHost({ directory, configProviders: layered })
  host.options = options
  const cleanup = await plugin.setup(host)
  await settle()
  await rpc(host).status({})
  return { host, cleanup, directory, layered }
}

/**
 * Runs `change` inside the `nth` integration reload issued after the project file contains `id`
 * (i.e. after the save). For a new provider the 1st is the activation reload and the 2nd the
 * ownership probe's injection-free reload; an existing provider's overwrite has no activation
 * reload, so its 1st is the probe. Records the ordered effects up to the credential action.
 */
function duringPostSaveReload(host, directory, id, nth, change) {
  const state = { changed: false, trace: [] }
  let reloads = 0
  const reload = host.integration.reload
  host.integration.reload = async () => {
    const text = await fs.readFile(configFile(directory), "utf8").catch(() => "")
    if (!state.changed && text.includes(`"${id}"`) && ++reloads === nth) {
      state.changed = true
      await change()
      host.emit({ type: "config.updated", data: {} })
      state.trace.push("change")
    }
    return reload()
  }
  const connect = host.integration.connect.key
  host.integration.connect.key = async (input) => {
    state.trace.push("connect.key")
    return connect(input)
  }
  return state
}

const editProject = (directory, edit) => async () => {
  const config = await readSaved(directory)
  edit(config)
  await fs.writeFile(configFile(directory), `${JSON.stringify(config, null, 2)}\n`)
}

function assertConflict(result, state, host) {
  assert.equal(state.changed, true, "the change ran during the probe")
  assert.deepEqual(state.trace, ["change"], "no credential action after the change")
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, "conflict")
  assert.match(result.message, /was saved to .*opencode\.jsonc/)
  assert.match(result.message, /API key was not stored/)
  assert.equal(result.credentialStored, undefined)
  assert.deepEqual(host.calls.connectKey, [], "credential not stored")
}

// ── P3-M2b: the saved project entry changes during the probe of a new provider ──

const PROJECT_EDITS = [
  ["deleted", (config) => { config.providers = {} }],
  ["whole file emptied", (config) => { for (const key of Object.keys(config)) delete config[key] }],
  ["URL changed", (config) => { config.providers.newkey.settings.baseURL = `${fixture.baseURL}/other` }],
  ["package changed", (config) => { config.providers.newkey.package = "@ai-sdk/openai-compatible" }],
  ["explicit models added", (config) => { config.providers.newkey.models = { manual: { name: "USER OWNED" } } }],
]

for (const [label, edit] of PROJECT_EDITS) {
  test(`P3-M2b: new provider's saved entry ${label} during the ownership probe -> conflict, key not stored, file kept`, async () => {
    const { host, directory, cleanup } = await boot()
    const state = duringPostSaveReload(host, directory, "newkey", 2, editProject(directory, edit))
    const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: KEY })
    assertConflict(result, state, host)
    // The user's edit is preserved, never undone or rewritten.
    const expected = { providers: { newkey: { package: NATIVE, settings: { baseURL: fixture.baseURL } } } }
    edit(expected)
    assert.deepEqual(await readSaved(directory), expected)
    await settle(50)
    assert.equal(await managed(host, "newkey"), false, "pending addition and inventory retired")
    await host.provider.reload()
    assert.equal(host.records().get("newkey"), undefined, "nothing injected")
    await cleanup()
  })
}

test("P3-M2b review repro: deletion during the second post-save reload (the probe) -> conflict", async () => {
  // Exact reviewer order: RPC add `newkey`; on its 2nd post-save integration reload write `{}`
  // to the project config and emit config.updated; the host fold is then empty.
  const { host, directory, cleanup } = await boot()
  const state = duringPostSaveReload(host, directory, "newkey", 2, () => fs.writeFile(configFile(directory), "{}\n"))
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: "fake-independent-key" })
  assertConflict(result, state, host)
  assert.deepEqual(await readSaved(directory), {})
  await cleanup()
})

test("P3-M2b: existing provider's saved entry deleted during the ownership probe -> conflict, key not stored", async () => {
  const proxy = { package: NATIVE, settings: { baseURL: fixture.baseURL } }
  const { host, directory, cleanup } = await boot({ project: { proxy }, layered: { proxy: { ...proxy } } })
  assert.equal(await managed(host, "proxy"), true)
  const state = duringPostSaveReload(host, directory, "proxy", 1, editProject(directory, (config) => { config.providers = {} }))
  const result = await rpc(host).addProvider({ providerID: "proxy", baseURL: `${fixture.baseURL}/`, overwrite: true, apiKey: KEY })
  assertConflict(result, state, host)
  assert.deepEqual(await readSaved(directory), { providers: {} })
  await cleanup()
})

test("P3-M2b control: an unchanged rewrite of the saved entry during the probe still stores the key", async () => {
  const { host, directory, cleanup } = await boot()
  const state = duringPostSaveReload(host, directory, "newkey", 2, editProject(directory, () => {}))
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: KEY })
  assert.equal(state.changed, true)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.credentialStored, true)
  assert.deepEqual(state.trace, ["change", "connect.key"])
  await settle(50)
  assert.equal(await managed(host, "newkey"), true)
  await cleanup()
})

test("P3-M2b control: discover:true keeps explicit models added during the probe managed; the key is stored", async () => {
  const { host, directory, cleanup } = await boot({ options: { providers: { newkey: { discover: true } } } })
  const state = duringPostSaveReload(host, directory, "newkey", 2, editProject(directory, (config) => { config.providers.newkey.models = { alpha: { name: "USER OWNED" } } }))
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: KEY })
  assert.equal(state.changed, true)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.credentialStored, true)
  await cleanup()
})

// ── P3-M2a: an eligible existing provider's authoritative source changes during the probe ──

const LAYER_SOURCE_CHANGES = [
  ["URL changed", (layered) => { layered.proxy = { package: NATIVE, settings: { baseURL: `${fixture.baseURL}/other` } } }],
  ["package changed", (layered) => { layered.proxy = { package: "@ai-sdk/openai-compatible", settings: { baseURL: fixture.baseURL } } }],
  // Adjacent binding check (already enforced before pass 4): a layer binds its own settings key.
  ["settings key bound", (layered) => { layered.proxy = { package: NATIVE, settings: { baseURL: fixture.baseURL, apiKey: "fake-layer-settings-key-0099" } } }],
]

for (const [label, change] of LAYER_SOURCE_CHANGES) {
  test(`P3-M2a: existing provider's layer source ${label} during the ownership probe -> conflict, key not stored`, async () => {
    const proxy = { package: NATIVE, settings: { baseURL: fixture.baseURL } }
    const { host, directory, layered, cleanup } = await boot({ project: { proxy }, layered: { proxy: { ...proxy } } })
    assert.equal(await managed(host, "proxy"), true)
    const state = duringPostSaveReload(host, directory, "proxy", 1, async () => change(layered))
    const result = await rpc(host).addProvider({ providerID: "proxy", baseURL: `${fixture.baseURL}/`, overwrite: true, apiKey: KEY })
    assertConflict(result, state, host)
    // The saved entry is left as written.
    assert.equal((await readSaved(directory)).providers.proxy.settings.baseURL, fixture.baseURL)
    await cleanup()
  })
}

test("P3-M2a control: delayed config adoption (the host folds the saved new URL during the probe) stores the key", async () => {
  const other = await startFixture({ models: ["gamma"] })
  try {
    const proxy = { package: NATIVE, settings: { baseURL: fixture.baseURL } }
    const { host, directory, layered, cleanup } = await boot({ project: { proxy }, layered: { proxy: { ...proxy } } })
    assert.equal(await managed(host, "proxy"), true)
    const state = duringPostSaveReload(host, directory, "proxy", 1, async () => {
      layered.proxy = { package: NATIVE, settings: { baseURL: other.baseURL } }
    })
    const result = await rpc(host).addProvider({ providerID: "proxy", baseURL: other.baseURL, overwrite: true, apiKey: KEY })
    assert.equal(state.changed, true)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.credentialStored, true)
    assert.deepEqual(state.trace, ["change", "connect.key"])
    await settle(50)
    await host.provider.reload()
    assert.deepEqual([...host.records().get("proxy").models.keys()], ["gamma"], "the saved source's inventory is adopted")
    await cleanup()
  } finally {
    await other.close()
  }
})

test("P3-M2a control: the host still on the previous URL during the probe (adoption pending) stores the key", async () => {
  const other = await startFixture({ models: ["gamma"] })
  try {
    const proxy = { package: NATIVE, settings: { baseURL: fixture.baseURL } }
    const { host, directory, cleanup } = await boot({ project: { proxy }, layered: { proxy: { ...proxy } } })
    const state = duringPostSaveReload(host, directory, "proxy", 1, async () => {})
    const result = await rpc(host).addProvider({ providerID: "proxy", baseURL: other.baseURL, overwrite: true, apiKey: KEY })
    assert.equal(state.changed, true)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.credentialStored, true)
    assert.match(result.warnings.join("\n"), /switches 'proxy' to the new base URL/)
    await cleanup()
  } finally {
    await other.close()
  }
})
