// Regression tests for fresh re-review findings F1-F4 (corrective pass 2) and the RPC guard minor.
// Fixtures are loopback-only with fake keys.
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import fsSync from "node:fs"
import { spawn } from "node:child_process"
import plugin from "../../packages/v2/dist/v2/server.js"
import { createService } from "../../packages/v2/dist/v2/service.js"
import { parseOptions } from "../../packages/v2/dist/v2/options.js"
import { isAddProviderResult, isRefreshResult } from "../../packages/v2/dist/v2/rpc.js"
import { ConfigError, persistProvider, readProviderIds } from "../../packages/v2/dist/v2/persist.js"
import { clearModelsDevCache } from "../../packages/v2/dist/v2/discover.js"
import { createHost, settle, startFixture, stubModelsDev, tempDir, until } from "./helpers.mjs"

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

const configFile = (directory) => path.join(directory, "opencode.jsonc")
const readConfig = async (directory) => JSON.parse(await fs.readFile(configFile(directory), "utf8"))
const rpc = (host) => host.rpcs.at(-1).handlers
const models = (host, id) => {
  const record = host.records().get(id)
  return record ? [...record.models.keys()].sort() : undefined
}

async function editConfig(directory, edit) {
  const config = await readConfig(directory)
  edit(config)
  await fs.writeFile(configFile(directory), JSON.stringify(config, null, 2))
}

async function bootFile(providers, hostOptions = {}, options = {}) {
  const directory = await tempDir()
  await fs.writeFile(configFile(directory), JSON.stringify({ providers }, null, 2))
  const host = createHost({ directory, configFromFile: true, ...hostOptions })
  host.options = options
  const cleanup = await plugin.setup(host)
  await settle()
  await rpc(host).status({})
  return { host, cleanup, directory }
}

async function bootStatic(configProviders, hostOptions = {}, options = {}) {
  const directory = await tempDir()
  const host = createHost({ directory, configProviders, ...hostOptions })
  host.options = options
  const cleanup = await plugin.setup(host)
  await settle()
  await rpc(host).status({})
  return { host, cleanup, directory }
}

const managed = async (host, id) => (await rpc(host).status({})).providers.some((p) => p.id === id)

// ── F1: explicit config models own a provider even when their IDs overlap discovered IDs ──

for (const configOrder of ["after", "before"]) {
  for (const [label, explicit] of [
    ["same ID", { beta: { name: "USER OWNED" } }],
    ["same ID, disabled", { beta: { disabled: true } }],
    ["same ID, empty override", { alpha: {} }],
    ["distinct ID", { manual: {} }],
  ]) {
    test(`F1 (${configOrder}): explicit config models (${label}) opt a discovered provider out; old inventory is retired`, async () => {
      const { host, directory, cleanup } = await bootFile({ proxy: { settings: { baseURL: fixture.baseURL } } }, { configOrder })
      assert.deepEqual(models(host, "proxy"), ["alpha", "beta"])
      await editConfig(directory, (config) => (config.providers.proxy.models = explicit))
      await host.configReload()
      // The endpoint keeps serving the overlapping ID plus a new one.
      fixture.state.models = ["alpha", "beta", "replacement"]
      const requests = fixture.state.seenAuth.length
      const expected = Object.keys(explicit).sort().join()
      await until(async () => !(await managed(host, "proxy")) && models(host, "proxy")?.join() === expected, 2000, "opted out")
      const refreshed = await rpc(host).refresh({})
      assert.equal(refreshed.providerCount, 0, JSON.stringify(refreshed))
      assert.deepEqual(models(host, "proxy"), Object.keys(explicit).sort(), "only the config's own models remain")
      assert.equal(fixture.state.seenAuth.length, requests, "no discovery after config took ownership")
      const targeted = await rpc(host).refresh({ providerID: "proxy" })
      assert.match(targeted.errors.join(), /not eligible/)
      await cleanup()
    })
  }
}

test("F1: discover:true keeps managing a provider whose explicit models overlap discovered IDs", async () => {
  const { host, directory, cleanup } = await bootFile({ proxy: { settings: { baseURL: fixture.baseURL } } }, {}, { providers: { proxy: { discover: true } } })
  await editConfig(directory, (config) => (config.providers.proxy.models = { beta: { name: "USER OWNED" } }))
  await host.configReload()
  fixture.state.models = ["alpha", "beta", "replacement"]
  await settle(50)
  const refreshed = await rpc(host).refresh({})
  assert.deepEqual(refreshed.updatedProviderIds, ["proxy"])
  assert.deepEqual(models(host, "proxy"), ["alpha", "beta", "replacement"])
  assert.equal(host.models().get("proxy/beta").name, "USER OWNED", "config override keeps precedence")
  await cleanup()
})

test("F1: layered config (not the project file) taking ownership with an overlapping ID is honoured", async () => {
  // Static host config stands in for a global/other config layer the project-file shortcut cannot see.
  const layered = { proxy: { settings: { baseURL: fixture.baseURL } } }
  const { host, cleanup } = await bootStatic(layered)
  assert.deepEqual(models(host, "proxy"), ["alpha", "beta"])
  layered.proxy.models = { beta: { name: "LAYER OWNED" } }
  // Core reacting to a layered config change: config.updated, then its config plugin reloads.
  host.emit({ type: "config.updated", data: {} })
  await host.provider.reload()
  fixture.state.models = ["alpha", "beta", "replacement"]
  await until(async () => !(await managed(host, "proxy")), 2000, "opted out")
  await rpc(host).refresh({})
  assert.deepEqual(models(host, "proxy"), ["beta"])
  await cleanup()
})

test("F1: a session-added provider whose ID a config layer then defines with overlapping explicit models is retired", async () => {
  const layered = {}
  const { host, cleanup } = await bootStatic(layered)
  const added = await rpc(host).addProvider({ providerID: "added", baseURL: fixture.baseURL })
  assert.equal(added.ok, true, added.message)
  assert.deepEqual(models(host, "added"), ["alpha", "beta"])
  layered.added = { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: fixture.baseURL }, models: { alpha: {} } }
  host.emit({ type: "config.updated", data: {} })
  await host.provider.reload()
  await until(async () => !(await managed(host, "added")), 2000, "retired")
  await host.provider.reload()
  assert.deepEqual(models(host, "added"), ["alpha"])
  await cleanup()
})

for (const withEvent of [true, false]) {
  test(`F1: a config change folded while the plugin is mid-reload (counted as its own fold) is caught ${withEvent ? "via config.updated" : "by the next explicit refresh"}`, async () => {
    const layered = { proxy: { settings: { baseURL: fixture.baseURL } } }
    const { host, cleanup } = await bootStatic(layered)
    const reload = host.integration.reload
    let armed = true
    host.integration.reload = async () => {
      if (armed) {
        armed = false
        layered.proxy.models = { beta: {} }
        await host.provider.reload() // interleaves with the plugin's own reload below
        if (withEvent) host.emit({ type: "config.updated", data: {} })
      }
      return reload()
    }
    const added = await rpc(host).addProvider({ providerID: "other", baseURL: fixture.baseURL })
    assert.equal(added.ok, true, added.message)
    if (withEvent) {
      await until(async () => !(await managed(host, "proxy")) && models(host, "proxy")?.join() === "beta", 3000, "ownership re-checked")
    } else {
      await rpc(host).refresh({})
      assert.equal(await managed(host, "proxy"), false)
      assert.deepEqual(models(host, "proxy"), ["beta"])
    }
    await cleanup()
  })
}

test("F1: refresh admitted right after an external ownership change never re-injects the owned provider", async () => {
  const { host, directory, cleanup } = await bootFile({ proxy: { settings: { baseURL: fixture.baseURL } } })
  await editConfig(directory, (config) => (config.providers.proxy.models = { beta: {} }))
  fixture.state.models = ["alpha", "beta", "replacement"]
  // Fold and refresh in the same tick: refresh must establish ownership before discovering.
  await host.configReload()
  const refreshed = await rpc(host).refresh({})
  assert.equal(refreshed.updatedProviderIds.includes("proxy"), false, JSON.stringify(refreshed))
  assert.deepEqual(models(host, "proxy"), ["beta"])
  await cleanup()
})

// ── F2: in-flight add/overwrite is bound to what it started from ──

async function heldOverwrite(change, hostOptions = {}) {
  const booted = await bootFile({ race: { settings: { baseURL: fixture.baseURL } } }, hostOptions)
  fixture.state.hold = true
  fixture.state.held = []
  const pending = rpc(booted.host).addProvider({ providerID: "race", baseURL: `${fixture.baseURL}/`, overwrite: true })
  await until(() => fixture.state.held.length === 1, 2000, "discovery in flight")
  await change(booted)
  fixture.state.hold = false
  for (const release of fixture.state.held) release()
  const result = await pending
  await settle(50)
  return { ...booted, result }
}

test("F2 review repro: provider deleted while overwrite discovery is blocked -> conflict, never resurrected", async () => {
  const { host, directory, result, cleanup } = await heldOverwrite(async ({ host, directory }) => {
    await editConfig(directory, (config) => delete config.providers.race)
    await host.configReload()
  })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, "conflict")
  assert.deepEqual((await readConfig(directory)).providers, {}, "deletion survives")
  assert.equal(host.records().has("race"), false)
  await host.provider.reload()
  assert.equal(host.records().has("race"), false, "not resurrected on later folds")
  await cleanup()
})

test("F2: provider deleted from the file but not yet folded by the host -> conflict inside the locked transaction", async () => {
  const { directory, result, cleanup } = await heldOverwrite(async ({ directory }) => {
    await editConfig(directory, (config) => delete config.providers.race)
  })
  assert.equal(result.code, "conflict", JSON.stringify(result))
  assert.deepEqual((await readConfig(directory)).providers, {})
  await cleanup()
})

for (const [label, edit] of [
  ["explicit model takeover", (p) => (p.models = { alpha: {} })],
  ["URL edit", (p) => (p.settings.baseURL = "http://127.0.0.1:9/v1")],
  ["package edit", (p) => (p.package = "@ai-sdk/openai-compatible")],
  ["user field edit", (p) => (p.headers = { "x-user": "1" })],
]) {
  test(`F2: ${label} while overwrite discovery is blocked -> conflict; the user's edit is kept`, async () => {
    let expected
    const { directory, result, cleanup } = await heldOverwrite(async ({ host, directory }) => {
      await editConfig(directory, (config) => edit(config.providers.race))
      expected = (await readConfig(directory)).providers.race
      await host.configReload()
    })
    assert.equal(result.code, "conflict", JSON.stringify(result))
    assert.deepEqual((await readConfig(directory)).providers.race, expected)
    await cleanup()
  })
}

test("F2: a layered provider that disappears from the host during overwrite discovery -> conflict, nothing written", async () => {
  const layered = { race: { settings: { baseURL: fixture.baseURL } } }
  const { host, directory, cleanup } = await bootStatic(layered)
  fixture.state.hold = true
  fixture.state.held = []
  const pending = rpc(host).addProvider({ providerID: "race", baseURL: fixture.baseURL, overwrite: true })
  await until(() => fixture.state.held.length === 1, 2000, "discovery in flight")
  delete layered.race
  await host.provider.reload()
  fixture.state.hold = false
  for (const release of fixture.state.held) release()
  const result = await pending
  assert.equal(result.code, "conflict", JSON.stringify(result))
  assert.equal(await fs.stat(configFile(directory)).then(() => true, () => false), false)
  await cleanup()
})

test("F2: a new provider ID created by someone else during discovery is never overwritten", async () => {
  const { host, directory, cleanup } = await bootFile({})
  fixture.state.hold = true
  fixture.state.held = []
  const pending = rpc(host).addProvider({ providerID: "fresh", baseURL: fixture.baseURL, overwrite: true })
  await until(() => fixture.state.held.length === 1, 2000, "discovery in flight")
  await editConfig(directory, (config) => (config.providers.fresh = { settings: { baseURL: "http://127.0.0.1:9/v1" } }))
  fixture.state.hold = false
  for (const release of fixture.state.held) release()
  const result = await pending
  assert.equal(result.code, "conflict", JSON.stringify(result))
  assert.equal((await readConfig(directory)).providers.fresh.settings.baseURL, "http://127.0.0.1:9/v1")
  await cleanup()
})

test("F2: provider deleted after it was saved but before the key is stored -> key not stored, not injected", async () => {
  const { host, directory, cleanup } = await bootFile({})
  // Core reacting to the write and to a user deleting the provider straight after, during our reload.
  const reload = host.integration.reload
  let armed = true
  host.integration.reload = async () => {
    if (armed && (await readConfig(directory)).providers.newkey) {
      armed = false
      await editConfig(directory, (config) => delete config.providers.newkey)
      await host.configReload()
    }
    return reload()
  }
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: "fake-key-abcdef" })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, "conflict")
  assert.deepEqual(host.calls.connectKey, [], "credential not stored")
  await host.provider.reload()
  assert.equal(host.records().has("newkey"), false)
  await cleanup()
})

test("F2: an unchanged provider still updates normally (no false conflicts from the host folding our own write)", async () => {
  const { host, directory, cleanup } = await bootFile({ race: { settings: { baseURL: fixture.baseURL } } })
  const result = await rpc(host).addProvider({ providerID: "race", baseURL: `${fixture.baseURL}/`, overwrite: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  await host.configReload()
  const added = await rpc(host).addProvider({ providerID: "brandnew", baseURL: fixture.baseURL })
  assert.equal(added.ok, true, JSON.stringify(added))
  await host.configReload()
  await until(async () => (await rpc(host).status({})).providers.find((p) => p.id === "brandnew")?.pending === undefined, 2000, "acknowledged")
  assert.deepEqual(models(host, "brandnew"), ["alpha", "beta"])
  assert.ok((await readConfig(directory)).providers.brandnew)
  await cleanup()
})

// ── F4: lifecycle checkpoints after every awaited bootstrap effect ──

function gatedHost(gateOn) {
  let release
  let entered
  const gate = new Promise((resolve) => (release = resolve))
  const ready = new Promise((resolve) => (entered = resolve))
  const calls = []
  const step = (name) => async () => {
    calls.push(name)
    if (name === gateOn) {
      entered()
      await gate
      calls.push(`${name}:returned`)
    }
    return name === "model-list" ? [] : undefined
  }
  const host = {
    location: { directory: "/nonexistent-dcp-test" },
    provider: { reload: step("provider-reload") },
    model: { reload: step("model-reload"), list: step("model-list") },
    integration: {
      reload: step("integration-reload"),
      connection: { active: async () => undefined },
      connect: { key: async () => calls.push("connect-key") },
    },
  }
  return { host, calls, release: () => release(), ready }
}

for (const gateOn of ["provider-reload", "model-reload"]) {
  test(`F4 review repro: dispose while bootstrap ${gateOn} is blocked -> no later host reload/list`, async () => {
    const { host, calls, release, ready } = gatedHost(gateOn)
    const service = createService(host, parseOptions({}))
    const adding = service.addProvider({ providerID: "late", baseURL: "http://127.0.0.1:9/v1" }, { caller: "user" })
    const queued = service.refresh({}, { caller: "user" })
    await ready
    const disposing = service.dispose()
    const before = calls.length
    release()
    const [added, refreshed] = await Promise.all([adding, queued])
    await disposing
    assert.equal(added.code, "cancelled")
    assert.equal(refreshed.cancelled, true)
    assert.deepEqual(calls.slice(before), [`${gateOn}:returned`], `no effect after disposal: ${calls.join(" > ")}`)
  })

  test(`F4: an RPC call abort while bootstrap ${gateOn} is blocked -> no later reload/list for that call`, async () => {
    const { host, calls, release, ready } = gatedHost(gateOn)
    const service = createService(host, parseOptions({}))
    const controller = new AbortController()
    const adding = service.addProvider({ providerID: "late", baseURL: "http://127.0.0.1:9/v1" }, { caller: "user", signal: controller.signal })
    await ready
    controller.abort()
    const before = calls.length
    release()
    assert.equal((await adding).code, "cancelled")
    assert.deepEqual(calls.slice(before), [`${gateOn}:returned`], calls.join(" > "))
    await service.dispose()
  })
}

test("F4: unobserved admission via refresh and settled status, disposed during the first provider reload", async () => {
  const { host, calls, release, ready } = gatedHost("provider-reload")
  const service = createService(host, parseOptions({}))
  const refreshing = service.refresh({}, { caller: "user" })
  const statusing = service.settledStatus()
  const adding = service.addProvider({ providerID: "q", baseURL: "http://127.0.0.1:9/v1" }, { caller: "user" })
  await ready
  const disposing = service.dispose()
  const before = calls.length
  release()
  const [refreshed, status, added] = await Promise.all([refreshing, statusing, adding])
  await disposing
  assert.equal(refreshed.cancelled, true)
  assert.deepEqual(status, [])
  assert.equal(added.code, "cancelled")
  assert.deepEqual(calls.slice(before), ["provider-reload:returned"], calls.join(" > "))
})

// ── Minor: discriminated RPC result guards ──

const status = { id: "p", baseURL: "http://x/v1", models: 1, modelIDs: ["m"] }
const refreshOK = { providerCount: 1, totalModels: 1, failures: 0, updatedProviderIds: ["p"], warnings: [], errors: [], providers: [status] }

test("minor: isRefreshResult validates provider members, cancelled and finite non-negative integer counts", () => {
  assert.equal(isRefreshResult(refreshOK), true)
  assert.equal(isRefreshResult({ ...refreshOK, cancelled: true }), true)
  assert.equal(isRefreshResult({ ...refreshOK, providers: [{ ...status, refreshedAt: 1, lastError: "e", pending: true }] }), true)
  for (const bad of [
    { ...refreshOK, cancelled: "yes" },
    { ...refreshOK, providerCount: -1 },
    { ...refreshOK, totalModels: Number.NaN },
    { ...refreshOK, failures: Number.POSITIVE_INFINITY },
    { ...refreshOK, totalModels: 1.5 },
    { ...refreshOK, providers: [null] },
    { ...refreshOK, providers: [{ ...status, id: 1 }] },
    { ...refreshOK, providers: [{ ...status, models: -2 }] },
    { ...refreshOK, providers: [{ ...status, modelIDs: [1] }] },
    { ...refreshOK, providers: [{ ...status, pending: "no" }] },
    { ...refreshOK, providers: [{ ...status, refreshedAt: Number.NaN }] },
    { ...refreshOK, providers: [{ ...status, lastError: 3 }] },
  ]) {
    assert.equal(isRefreshResult(bad), false, JSON.stringify(bad))
  }
})

test("minor: isAddProviderResult requires success fields with valid values and a known failure code", () => {
  const ok = { ok: true, message: "m", modelCount: 2, configPath: "/p/opencode.jsonc", credentialStored: false, warnings: [] }
  assert.equal(isAddProviderResult(ok), true)
  assert.equal(isAddProviderResult({ ok: false, code: "conflict", message: "m" }), true)
  for (const bad of [
    { ...ok, modelCount: -1 },
    { ...ok, modelCount: Number.NaN },
    { ...ok, modelCount: 0.5 },
    { ...ok, configPath: undefined },
    { ...ok, credentialStored: "no" },
    { ...ok, warnings: [1] },
    { ok: false, message: "m" },
    { ok: false, code: "unknown", message: "m" },
    { ok: "true", message: "m" },
  ]) {
    assert.equal(isAddProviderResult(bad), false, JSON.stringify(bad))
  }
})

// ── F3: persistence target identity and lock ownership ──

const PKG = "@opencode/ai/providers/openai-compatible"
const entry = { package: PKG, baseURL: "http://127.0.0.1:9/v1" }
const lockOf = (dir) => path.join(dir, ".opencode.jsonc.lock")
const readOptional = (read) => { try { return read().trim() } catch { return undefined } }
const PID_NS = readOptional(() => fsSync.readlinkSync("/proc/self/ns/pid"))
const BOOT_ID = readOptional(() => fsSync.readFileSync("/proc/sys/kernel/random/boot_id", "utf8"))
const startOf = (pid) => readOptional(() => { const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] })
/** A lock owner record as this host writes it. */
const owner = (fields) => JSON.stringify({ host: os.hostname(), ...(PID_NS ? { pidns: PID_NS } : {}), ...(BOOT_ID ? { boot: BOOT_ID } : {}), time: Date.now(), ...fields })
const persistURL = new URL("../../packages/v2/dist/v2/persist.js", import.meta.url).href

/** Runs persistProvider in a separate process; resolves with { status, stderr }. */
function persistInChild(dir, id, options = {}) {
  const code = `import { persistProvider } from ${JSON.stringify(persistURL)}
try { await persistProvider(${JSON.stringify(dir)}, ${JSON.stringify(id)}, ${JSON.stringify(entry)}, ${JSON.stringify(options)}) }
catch (error) { process.stderr.write(String(error.code) + ": " + error.message); process.exit(3) }`
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("exit", (status) => resolve({ status, stderr }))
  })
}

function aliveChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  return child
}

test("F3: a config symlink retargeted during the transaction is re-resolved; the old target is never written", async () => {
  const store = await tempDir()
  const project = await tempDir()
  const oldTarget = path.join(store, "old.jsonc")
  const newTarget = path.join(store, "new.jsonc")
  const link = path.join(project, "opencode.jsonc")
  await fs.writeFile(oldTarget, "{}\n")
  await fs.writeFile(newTarget, '{ "newTarget": true }\n')
  await fs.symlink(oldTarget, link)
  let once = true
  await persistProvider(project, "ours", entry, {
    beforeReplace: async () => {
      if (!once) return
      once = false
      await fs.unlink(link)
      await fs.symlink(newTarget, link)
    },
  })
  assert.equal(await fs.readFile(oldTarget, "utf8"), "{}\n", "old target untouched")
  const selected = JSON.parse(await fs.readFile(link, "utf8"))
  assert.equal(selected.newTarget, true)
  assert.ok(selected.providers.ours, "written to the currently selected target")
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
})

test("F3: a target that keeps being retargeted fails with a conflict and writes neither file", async () => {
  const store = await tempDir()
  const project = await tempDir()
  const a = path.join(store, "a.jsonc")
  const b = path.join(store, "b.jsonc")
  const link = path.join(project, "opencode.jsonc")
  await fs.writeFile(a, "{}\n")
  await fs.writeFile(b, "{}\n")
  await fs.symlink(a, link)
  let flip = false
  await assert.rejects(
    persistProvider(project, "ours", entry, {
      beforeReplace: async () => {
        flip = !flip
        await fs.unlink(link)
        await fs.symlink(flip ? b : a, link)
      },
    }),
    (error) => error instanceof ConfigError && error.code === "conflict",
  )
  assert.equal(await fs.readFile(a, "utf8"), "{}\n")
  assert.equal(await fs.readFile(b, "utf8"), "{}\n")
})

test("F3: a lock held by a live process is never broken by age; the caller gets busy", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  const child = aliveChild()
  try {
    const lock = owner({ pid: child.pid, start: startOf(child.pid), token: "live-other", time: Date.now() - 3_600_000 })
    await fs.writeFile(lockOf(dir), lock)
    await assert.rejects(persistProvider(dir, "stealer", entry, { lockTimeout: 300 }), (error) => error.code === "busy")
    assert.equal(await fs.readFile(lockOf(dir), "utf8"), lock, "live owner's lock intact")
    assert.deepEqual(await readProviderIds(dir), [])
  } finally {
    child.kill()
  }
})

test("F3: a live holder in this process keeps its aged lock against another process", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  let release
  let entered
  const gate = new Promise((resolve) => (release = resolve))
  const ready = new Promise((resolve) => (entered = resolve))
  const holder = persistProvider(dir, "holder", entry, {
    beforeReplace: async () => {
      entered()
      await gate
    },
  })
  await ready
  // Age the live lock as if this holder had stalled for an hour.
  const owned = JSON.parse(await fs.readFile(lockOf(dir), "utf8"))
  await fs.writeFile(lockOf(dir), JSON.stringify({ ...owned, time: Date.now() - 3_600_000 }))
  const other = await persistInChild(dir, "other", { lockTimeout: 400 })
  assert.equal(other.status, 3, other.stderr)
  assert.match(other.stderr, /^busy:/)
  release()
  await holder
  assert.deepEqual(await readProviderIds(dir), ["holder"])
  assert.equal(await fs.stat(lockOf(dir)).then(() => true, () => false), false, "released")
})

test("F3 review repro: an aged lock naming this live process (same start time) is never broken", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  const lock = owner({ pid: process.pid, start: startOf(process.pid), token: "live-owner", time: Date.now() - 31_000 })
  await fs.writeFile(lockOf(dir), lock)
  await assert.rejects(persistProvider(dir, "stealer", entry, { lockTimeout: 300 }), (error) => error.code === "busy")
  assert.equal(await fs.readFile(lockOf(dir), "utf8"), lock)
})

test("F3: a lock from a previous incarnation of this PID (other start time) or an earlier boot is broken", { skip: !PID_NS }, async () => {
  for (const fields of [{ pid: process.pid, start: "1" }, { pid: process.pid, start: startOf(process.pid), boot: "00000000-0000-0000-0000-000000000000" }]) {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
    await fs.writeFile(lockOf(dir), owner({ ...fields, token: "previous" }))
    await persistProvider(dir, "ours", entry, { lockTimeout: 2000 })
    assert.deepEqual(await readProviderIds(dir), ["ours"])
  }
})

test("F3: a lock from another PID namespace on the same hostname (container) is never judged by local PIDs", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  const lock = owner({ pid: 2 ** 22 + 99, pidns: "pid:[1]", token: "container" })
  await fs.writeFile(lockOf(dir), lock)
  await assert.rejects(persistProvider(dir, "ours", entry, { lockTimeout: 300 }), (error) => error.code === "busy")
  assert.equal(await fs.readFile(lockOf(dir), "utf8"), lock)
})

test("F3: a lock from another host is never judged by local PIDs or age; the caller gets busy", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  const lock = JSON.stringify({ pid: 2 ** 22 + 4321, host: "some-other-host.invalid", token: "remote", time: 0 })
  await fs.writeFile(lockOf(dir), lock)
  await assert.rejects(persistProvider(dir, "ours", entry, { lockTimeout: 300 }), (error) => error.code === "busy" && error.message.includes(".opencode.jsonc.lock"))
  assert.equal(await fs.readFile(lockOf(dir), "utf8"), lock)
})

test("F3: a PID reused by an unrelated live process (different start time) does not keep a dead owner's lock", { skip: !fsSync.existsSync("/proc/self/stat") }, async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  const child = aliveChild()
  try {
    await fs.writeFile(lockOf(dir), owner({ pid: child.pid, start: "1", token: "reused" }))
    await persistProvider(dir, "ours", entry, { lockTimeout: 2000 })
    assert.deepEqual(await readProviderIds(dir), ["ours"])
  } finally {
    child.kill()
  }
})

test("F3: six processes racing to break one dead owner's lock never hold it together (no lost update)", async () => {
  for (let round = 0; round < 3; round++) {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
    await fs.writeFile(lockOf(dir), owner({ pid: 2 ** 22 + 777, token: "dead" }))
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => persistInChild(dir, `p${i}`)))
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    assert.deepEqual((await readProviderIds(dir)).sort(), ["p0", "p1", "p2", "p3", "p4", "p5"])
    assert.deepEqual((await fs.readdir(dir)).sort(), ["opencode.jsonc"])
  }
})

test("F3: if our lock is replaced mid-transaction we do not commit and do not delete the other owner's lock", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  await fs.writeFile(file, "{}\n")
  const foreign = owner({ pid: process.pid, start: startOf(process.pid), token: "someone-else" })
  await assert.rejects(
    persistProvider(dir, "ours", entry, { lockTimeout: 300, beforeReplace: () => fs.writeFile(lockOf(dir), foreign) }),
    (error) => error.code === "busy",
  )
  assert.equal(await fs.readFile(file, "utf8"), "{}\n", "nothing committed")
  assert.equal(await fs.readFile(lockOf(dir), "utf8"), foreign, "other owner's lock left in place")
})
