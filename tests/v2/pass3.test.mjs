// Regression tests for final-review findings M1 (cooperative stale-lock breaking) and M2
// (post-save config layer takeover before the credential is stored). Corrective pass 3.
// Fixtures are loopback-only with fake keys.
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import fsSync from "node:fs"
import { fork } from "node:child_process"
import plugin from "../../packages/v2/dist/v2/server.js"
import { persistProvider, readProviderIds } from "../../packages/v2/dist/v2/persist.js"
import { clearModelsDevCache } from "../../packages/v2/dist/v2/discover.js"
import { createHost, settle, startFixture, stubModelsDev, tempDir } from "./helpers.mjs"

const NATIVE = "@opencode/ai/providers/openai-compatible"
const entry = { package: NATIVE, baseURL: "http://127.0.0.1:9/v1" }
const lockOf = (dir) => path.join(dir, ".opencode.jsonc.lock")
const readOptional = (read) => { try { return read().trim() } catch { return undefined } }
const PID_NS = readOptional(() => fsSync.readlinkSync("/proc/self/ns/pid"))
const BOOT_ID = readOptional(() => fsSync.readFileSync("/proc/sys/kernel/random/boot_id", "utf8"))
const deadOwner = () => JSON.stringify({ pid: 2 ** 22 + 777, host: os.hostname(), ...(PID_NS ? { pidns: PID_NS } : {}), ...(BOOT_ID ? { boot: BOOT_ID } : {}), token: "dead", time: 0 })

// ── M1: breaking a dead owner's lock never displaces a live one ──

function child(role, dir) {
  const proc = fork(new URL("./lock-race-child.mjs", import.meta.url), [role, dir], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const messages = []
  const waiters = []
  proc.on("message", (message) => {
    messages.push(message)
    for (const wake of waiters.splice(0)) wake()
  })
  const exited = new Promise((resolve) => proc.on("exit", resolve))
  return {
    proc,
    exited,
    seen: (phase) => messages.find((m) => m.phase === phase),
    async wait(phase) {
      while (!messages.some((m) => m.phase === phase)) await new Promise((resolve) => waiters.push(resolve))
      return messages.find((m) => m.phase === phase)
    },
    resume: () => proc.send("continue"),
  }
}

test("M1 review repro: a breaker holding a stale observation cannot let a third writer in under a live holder (3 processes)", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  await fs.writeFile(file, "{}\n")
  await fs.writeFile(lockOf(dir), deadOwner())
  // 1. Breaker reads the dead owner's record, then stalls.
  const breaker = child("breaker", dir)
  await breaker.wait("dead-read")
  // 2. Holder breaks that dead lock itself, takes the lock and stalls after its final config read.
  const holder = child("holder", dir)
  await holder.wait("final-read")
  // 3. Breaker resumes on its stale observation and stalls again mid-break.
  breaker.resume()
  await breaker.wait("breaking")
  // 4. A third cooperating writer must not be admitted while the holder is live.
  const third = child("third", dir)
  await Promise.race([third.wait("done"), new Promise((resolve) => setTimeout(resolve, 400))])
  const admitted = third.seen("done")
  // 5. Let everyone finish.
  breaker.resume()
  holder.resume()
  const results = await Promise.all([holder.wait("done"), breaker.wait("done"), third.wait("done")])
  await Promise.all([holder.exited, breaker.exited, third.exited])
  assert.equal(admitted, undefined, "third writer admitted while the holder still owned the lock")
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result))
  // Every successful write is present: none was lost.
  assert.deepEqual((await readProviderIds(dir)).sort(), ["breaker", "holder", "third"])
  // Each holder released only its own lock: nothing is left behind.
  assert.deepEqual((await fs.readdir(dir)).sort(), ["opencode.jsonc"])
})

test("M1: an abandoned break marker fails closed (busy, manual recovery); neither lock file is removed", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  const dead = deadOwner()
  await fs.writeFile(lockOf(dir), dead)
  await fs.writeFile(`${lockOf(dir)}.break`, "")
  await assert.rejects(
    persistProvider(dir, "ours", entry, { lockTimeout: 300 }),
    (error) => error.code === "busy" && error.message.includes(".opencode.jsonc.lock.break"),
  )
  assert.equal(await fs.readFile(lockOf(dir), "utf8"), dead)
  assert.equal(await fs.readFile(`${lockOf(dir)}.break`, "utf8"), "")
  assert.deepEqual(await readProviderIds(dir), [])
  // After manual recovery (both files removed), writes proceed.
  await fs.unlink(lockOf(dir))
  await fs.unlink(`${lockOf(dir)}.break`)
  await persistProvider(dir, "ours", entry)
  assert.deepEqual(await readProviderIds(dir), ["ours"])
})

test("M1: an abandoned break marker does not block writers when the lock itself is free", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}\n")
  await fs.writeFile(`${lockOf(dir)}.break`, "")
  await persistProvider(dir, "ours", entry, { lockTimeout: 300 })
  assert.deepEqual(await readProviderIds(dir), ["ours"])
})

// ── M2: a config layer taking a just-saved provider over before its key is stored ──

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
const models = (host, id) => {
  const record = host.records().get(id)
  return record ? [...record.models.keys()].sort() : undefined
}
const managed = async (host, id) => (await rpc(host).status({})).providers.some((p) => p.id === id)

async function bootLayered(options = {}, files = {}) {
  const directory = await tempDir()
  if (files.project) await fs.writeFile(configFile(directory), JSON.stringify({ providers: files.project }, null, 2))
  const layered = files.layered ?? {}
  const host = createHost({ directory, configProviders: layered })
  host.options = options
  const cleanup = await plugin.setup(host)
  await settle()
  await rpc(host).status({})
  return { host, cleanup, directory, layered }
}

/** During the first integration reload after the project file was replaced (saved), another layer defines `id`. */
async function takeOverAfterSave(host, directory, layered, id, definition) {
  const inode = () => fs.stat(configFile(directory)).then((stat) => stat.ino, () => undefined)
  const before = await inode()
  const reload = host.integration.reload
  const state = { tookOver: false }
  host.integration.reload = async () => {
    if (!state.tookOver && (await inode()) !== before) {
      state.tookOver = true
      layered[id] = definition
      host.emit({ type: "config.updated", data: {} })
      await host.provider.reload()
    }
    return reload()
  }
  return state
}

const TAKEOVERS = [
  ["same ID", { alpha: { name: "USER OWNED" } }],
  ["same ID, disabled", { beta: { disabled: true } }],
  ["distinct ID", { manual: { name: "USER OWNED" } }],
]

for (const [label, explicit] of TAKEOVERS) {
  test(`M2 review repro: a config layer takes a new provider over (${label}) after it was saved -> conflict, key not stored`, async () => {
    const { host, directory, layered, cleanup } = await bootLayered()
    const state = await takeOverAfterSave(host, directory, layered, "newkey", { package: NATIVE, settings: { baseURL: fixture.baseURL }, models: explicit })
    const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: "fake-layer-key-012345" })
    assert.equal(state.tookOver, true)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, "conflict")
    assert.match(result.message, /was saved to .*opencode\.jsonc/)
    assert.match(result.message, /API key was not stored/)
    assert.deepEqual(host.calls.connectKey, [], "credential not stored")
    // The user's config (the saved project entry) is left as written: never undone.
    const saved = JSON.parse(await fs.readFile(configFile(directory), "utf8"))
    assert.equal(saved.providers.newkey.settings.baseURL, fixture.baseURL)
    await settle(50)
    assert.equal(await managed(host, "newkey"), false, "not managed")
    await host.provider.reload()
    assert.deepEqual(models(host, "newkey"), Object.keys(explicit).sort(), "only the layer's own models")
    await cleanup()
  })
}

test("M2: a layer taking over an existing provider's update after it was saved -> conflict, key not stored", async () => {
  const project = { proxy: { package: NATIVE, settings: { baseURL: fixture.baseURL } } }
  const { host, directory, layered, cleanup } = await bootLayered({}, { layered: { proxy: { ...project.proxy } }, project })
  assert.equal(await managed(host, "proxy"), true)
  const state = await takeOverAfterSave(host, directory, layered, "proxy", { package: NATIVE, settings: { baseURL: fixture.baseURL }, models: { alpha: { name: "USER OWNED" } } })
  const result = await rpc(host).addProvider({ providerID: "proxy", baseURL: `${fixture.baseURL}/`, overwrite: true, apiKey: "fake-layer-key-012345" })
  assert.equal(state.tookOver, true)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, "conflict")
  assert.deepEqual(host.calls.connectKey, [])
  await cleanup()
})

test("M2: discover:true keeps a post-save layer definition with overlapping models managed; the key is stored", async () => {
  const { host, directory, layered, cleanup } = await bootLayered({ providers: { newkey: { discover: true } } })
  const state = await takeOverAfterSave(host, directory, layered, "newkey", { package: NATIVE, settings: { baseURL: fixture.baseURL }, models: { alpha: { name: "USER OWNED" } } })
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: "fake-layer-key-012345" })
  assert.equal(state.tookOver, true)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.credentialStored, true)
  assert.deepEqual(host.calls.connectKey, [{ integrationID: "newkey" }])
  await settle(50)
  await host.provider.reload()
  assert.deepEqual(models(host, "newkey"), ["alpha", "beta"])
  assert.equal(host.models().get("newkey/alpha").name, "USER OWNED", "config override keeps precedence")
  await cleanup()
})

test("M2: a post-save layer with the same URL and another compatible package and no models stays managed; the key is stored", async () => {
  const { host, directory, layered, cleanup } = await bootLayered()
  // Same source as the saved entry (empty package folds to the native one), no explicit models.
  const state = await takeOverAfterSave(host, directory, layered, "newkey", { settings: { baseURL: fixture.baseURL } })
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: "fake-layer-key-012345" })
  assert.equal(state.tookOver, true)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.credentialStored, true)
  await settle(50)
  assert.equal(await managed(host, "newkey"), true)
  await cleanup()
})

test("M2: an existing provider with a compatible non-native package is still updated and its key stored", async () => {
  const project = { compat: { package: "@ai-sdk/openai-compatible", settings: { baseURL: fixture.baseURL } } }
  const { host, cleanup } = await bootLayered({}, { layered: { compat: { ...project.compat } }, project })
  assert.equal(await managed(host, "compat"), true)
  const result = await rpc(host).addProvider({ providerID: "compat", baseURL: `${fixture.baseURL}/`, overwrite: true, apiKey: "fake-compat-key-012345" })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.credentialStored, true)
  assert.deepEqual(host.calls.connectKey, [{ integrationID: "compat" }])
  await cleanup()
})

test("M2: a post-save layer that binds its own settings key to the provider -> conflict, the supplied key is not stored", async () => {
  const { host, directory, layered, cleanup } = await bootLayered()
  const state = await takeOverAfterSave(host, directory, layered, "newkey", { package: NATIVE, settings: { baseURL: fixture.baseURL, apiKey: "fake-layer-settings-key-0099" } })
  const result = await rpc(host).addProvider({ providerID: "newkey", baseURL: fixture.baseURL, apiKey: "fake-layer-key-012345" })
  assert.equal(state.tookOver, true)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, "conflict")
  assert.doesNotMatch(JSON.stringify(result), /fake-layer/)
  assert.deepEqual(host.calls.connectKey, [])
  await cleanup()
})
