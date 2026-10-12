// Shared test helpers. Real @opencode/schema statics and the real Effect schemas
// come from the V2 package's pinned devDependencies (@opencode/plugin@2.0.21).
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import fsSync from "node:fs"
import { createRequire } from "node:module"
import { Model, Provider } from "../../packages/v2/node_modules/@opencode/plugin/dist/promise/index.js"
import { Schema } from "../../packages/v2/node_modules/effect/dist/index.js"

export { Model, Provider, Schema }

const { parse: parseJsonc } = createRequire(import.meta.url)("../../packages/v2/node_modules/jsonc-parser")

// node --test runs files in parallel processes: give each its own models.dev cache, never ~/.cache.
process.env.XDG_CACHE_HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), "dcp-v2-cache-"))

export const DIST = new URL("../../packages/v2/dist/", import.meta.url)

const SECRET_RE = /sk-test-[a-z0-9-]+/i

/** Fails if `value` contains an sk-test-* key or any of `secrets` (raw, lower-case, URL- or base64-encoded). */
export function assertNoSecret(value, label = "value", secrets = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (SECRET_RE.test(text)) throw new Error(`${label} leaked a secret: ${text}`)
  for (const secret of secrets) {
    for (const form of [secret, secret.toLowerCase(), encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) {
      if (text.toLowerCase().includes(form.toLowerCase())) throw new Error(`${label} leaked ${JSON.stringify(secret)}: ${text}`)
    }
  }
}

export async function tempDir(prefix = "dcp-v2-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Loopback OpenAI-compatible fixture exposing GET /v1/models. */
export async function startFixture(initial = { models: ["fixture-a"] }) {
  const state = {
    models: initial.models,
    status: 200,
    requireKey: initial.requireKey,
    seenAuth: [],
  }
  const server = http.createServer((req, res) => {
    state.seenAuth.push(req.headers.authorization ?? null)
    state.seenPaths = [...(state.seenPaths ?? []), req.url]
    if (state.hold) {
      // Holds the response until the test releases it (in-flight cancellation tests).
      state.held = [...(state.held ?? []), () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: state.models.map((id) => ({ id })) })) }]
      req.on("close", () => state.closed = (state.closed ?? 0) + 1)
      return
    }
    if (state.echo !== undefined) {
      res.writeHead(state.echoStatus ?? 401, { "content-type": "text/plain" })
      res.end(state.echo)
      return
    }
    if (state.redirect) {
      res.writeHead(302, { location: state.redirect })
      res.end()
      return
    }
    if (state.requireKey && req.headers.authorization !== `Bearer ${state.requireKey}`) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }
    if (req.url?.startsWith("/v1/models")) {
      if (state.modelsByKey) {
        const list = state.modelsByKey[req.headers.authorization ?? ""]
        res.writeHead(list ? 200 : 401, { "content-type": "application/json" })
        res.end(JSON.stringify(list ? { data: list.map((id) => ({ id })) } : { error: "unauthorized" }))
        return
      }
      if (state.status !== 200) {
        res.writeHead(state.status)
        res.end("unavailable")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: state.models.map((id) => (typeof id === "string" ? { id } : id)) }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    state,
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Serves models.dev from memory so tests never touch the network. */
export function stubModelsDev(catalog = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === "https://models.dev/api.json") {
      return new Response(JSON.stringify(catalog), { status: 200 })
    }
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`Unexpected network fetch: ${url}`)
    return original(input, init)
  }
  return () => {
    globalThis.fetch = original
  }
}

/**
 * Minimal host mirroring core's transform semantics (2.0.21 State.create):
 * every reload replays all transforms, in registration order, from initial state.
 * The "config" transforms stand in for core's built-in `opencode.config.provider`
 * plugin. In the real 2.0.21 CLI that plugin folds AFTER external plugins
 * (observed in UAT plugin.list order), so `configOrder: "after"` is the default;
 * "before" checks that the plugin does not depend on fold order.
 */
/**
 * `configFromFile: true` makes the stand-in config plugin read `<directory>/opencode.json(c)`
 * on every fold, like core's opencode.config.provider after a config.updated event.
 */
export function createHost({ directory, configProviders: staticConfig = {}, credentials = {}, connectFails = false, configOrder = "after", events = true, configFromFile = false } = {}) {
  const readFileConfig = () => {
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      try {
        return parseJsonc(fsSync.readFileSync(path.join(directory, name), "utf8"))?.providers ?? {}
      } catch (error) {
        if (error.code !== "ENOENT") return {}
      }
    }
    return {}
  }
  let fileConfig = configFromFile ? readFileConfig() : {}
  const currentConfig = () => (configFromFile ? fileConfig : staticConfig)
  const providerTransforms = []
  const integrationTransforms = []
  const modelTransforms = []
  let records = new Map()
  let modelView = new Map()
  let integrations = new Map()
  // Core 2.0.21 keeps a list of credentials per integration; connection.active() returns the
  // newest one, then env names of the integration's env methods that are set (job-x5y9z3y2.js).
  let nextCredential = 0
  const credentialLists = new Map()
  const addCredential = (integrationID, value) => {
    const list = credentialLists.get(integrationID) ?? []
    list.push({ id: `cred_${++nextCredential}`, integrationID, value })
    credentialLists.set(integrationID, list)
  }
  for (const [id, value] of Object.entries(credentials)) addCredential(id, value)
  const stored = new Proxy({}, { get: (_, id) => credentialLists.get(id)?.at(-1)?.value })
  const calls = { providerReload: 0, integrationReload: 0, connectKey: [], active: 0 }
  const subscribers = new Set()
  const emit = (event) => { for (const push of subscribers) push(event) }

  function providerEditor(target) {
    const entry = (id) => {
      if (!target.has(id)) target.set(id, { provider: Provider.Info.empty(id), models: new Map() })
      return target.get(id)
    }
    return {
      list: () => [...target.values()],
      get: (id) => target.get(id),
      add: ({ info, models }) => target.set(info.id, { provider: structuredClone(info), models: new Map(models.map((m) => [m.id, m])) }),
      update: (id, update) => {
        const record = entry(id)
        update(record.provider)
        record.provider.id = id
      },
      remove: (id) => target.delete(id),
      models: {
        set: (id, values) => {
          entry(id).models = new Map(values.map((m) => [m.id, m]))
        },
        update: (providerID, modelID, update) => {
          const record = entry(providerID)
          const current = record.models.get(modelID)
          const model = current ? structuredClone(current) : Model.Info.default(providerID, modelID)
          update(model)
          model.id = modelID
          model.providerID = providerID
          record.models = new Map(record.models).set(modelID, model)
        },
        remove: (providerID, modelID) => target.get(providerID)?.models.delete(modelID),
      },
    }
  }

  function integrationEditor(target) {
    return {
      list: () => [...target.values()].map((i) => ({ id: i.id, name: i.name })),
      get: (id) => (target.has(id) ? { id, name: target.get(id).name } : undefined),
      update: (id, update) => {
        const current = target.get(id) ?? { id, name: id, methods: [] }
        update(current)
        target.set(id, current)
      },
      remove: (id) => target.delete(id),
      method: {
        list: (id) => target.get(id)?.methods ?? [],
        update: ({ integrationID, method }) => {
          const current = target.get(integrationID) ?? { id: integrationID, name: integrationID, methods: [] }
          current.methods = [...current.methods.filter((m) => m.type !== method.type), method]
          target.set(integrationID, current)
        },
        remove: () => undefined,
      },
    }
  }

  const configTransform = (editor) => {
    for (const [id, item] of Object.entries(currentConfig())) {
      editor.update(id, (provider) => {
        provider.activation = "enabled"
        if (item.name !== undefined) provider.name = item.name
        if (item.package !== undefined) provider.package = item.package
        if (item.settings !== undefined) provider.settings = { ...provider.settings, ...item.settings }
      })
      for (const modelID of Object.keys(item.models ?? {})) {
        if (!editor.get(id)?.models.has(modelID)) editor.models.update(id, modelID, () => undefined)
      }
    }
  }
  // Late explicit model overrides, like core's config provider model transform.
  const configModelOverrides = (editor) => {
    for (const [id, item] of Object.entries(currentConfig())) {
      for (const [modelID, override] of Object.entries(item.models ?? {})) {
        editor.update(id, modelID, (model) => {
          if (override.name !== undefined) model.name = override.name
          if (override.limit !== undefined) model.limit = { ...model.limit, ...override.limit }
          if (override.disabled !== undefined) model.enabled = !override.disabled
        })
      }
    }
  }

  function foldProviders() {
    const next = new Map()
    const editor = providerEditor(next)
    const ordered = configOrder === "before" ? [configTransform, ...providerTransforms] : [...providerTransforms, configTransform]
    for (const transform of ordered) transform(editor)
    records = next
    foldModels()
  }

  function foldModels() {
    const view = new Map()
    for (const [pid, record] of records) for (const [mid, model] of record.models) view.set(`${pid}/${mid}`, structuredClone(model))
    const editor = {
      provider: { list: () => [...records.values()], get: (id) => records.get(id) },
      list: (pid) => [...view.values()].filter((m) => !pid || m.providerID === pid),
      get: (pid, mid) => view.get(`${pid}/${mid}`),
      update: (pid, mid, update) => {
        if (!records.has(pid)) return
        const model = view.get(`${pid}/${mid}`) ?? Model.Info.default(pid, mid)
        update(model)
        view.set(`${pid}/${mid}`, model)
      },
      remove: (pid, mid) => view.delete(`${pid}/${mid}`),
      default: { get: () => undefined, set: () => undefined },
    }
    for (const transform of [...modelTransforms, configModelOverrides]) transform(editor)
    modelView = view
  }

  function foldIntegrations() {
    const next = new Map()
    const editor = integrationEditor(next)
    for (const id of Object.keys(currentConfig())) editor.method.update({ integrationID: id, method: { type: "key", label: "Manually enter API Key" } })
    for (const transform of integrationTransforms) transform(editor)
    integrations = next
  }

  const host = {
    location: { directory, project: { id: "test" } },
    options: {},
    calls,
    configProviders: staticConfig,
    stored,
    /** Simulates core reacting to config.updated: re-read the file, reload integrations + providers. */
    async configReload() {
      fileConfig = readFileConfig()
      calls.externalReload = (calls.externalReload ?? 0) + 1
      foldIntegrations()
      foldProviders()
    },
    records: () => records,
    models: () => modelView,
    integrations: () => integrations,
    provider: {
      transform: async (callback) => {
        providerTransforms.push(callback)
        foldProviders()
        return { dispose: async () => undefined }
      },
      reload: async () => {
        calls.providerReload++
        foldProviders()
      },
      list: async () => [...records.values()].map((r) => r.provider),
    },
    model: {
      transform: async (callback) => {
        modelTransforms.push(callback)
        foldModels()
        return { dispose: async () => undefined }
      },
      reload: async () => {
        calls.modelReload = (calls.modelReload ?? 0) + 1
        foldModels()
      },
      list: async () => [...modelView.values()],
    },
    integration: {
      transform: async (callback) => {
        integrationTransforms.push(callback)
        foldIntegrations()
        return { dispose: async () => undefined }
      },
      reload: async () => {
        calls.integrationReload++
        foldIntegrations()
      },
      connection: {
        active: async (id) => {
          calls.active++
          const newest = credentialLists.get(id)?.at(-1)
          if (newest) return { type: "credential", id: newest.id, label: "test", method: newest.value.type }
          const env = (integrations.get(id)?.methods ?? []).filter((m) => m.type === "env").flatMap((m) => m.names).find((name) => process.env[name])
          return env ? { type: "env", name: env } : undefined
        },
        resolve: async (connection) => {
          if (connection.type === "env") return process.env[connection.name] ? { type: "key", key: process.env[connection.name] } : undefined
          for (const list of credentialLists.values()) for (const item of list) if (item.id === connection.id) return item.value
          return undefined
        },
      },
      connect: {
        key: async (input) => {
          calls.connectKey.push({ integrationID: input.integrationID })
          if (connectFails) throw new Error(`credential store unavailable for ${input.key}`)
          if (!integrations.get(input.integrationID)?.methods.some((m) => m.type === "key")) {
            throw new Error(`Key method not found: ${input.integrationID}`)
          }
          addCredential(input.integrationID, { type: "key", key: input.key })
          emit({ type: "credential.updated", data: {} })
        },
      },
    },
    /** Stores a credential like /connect does on the server (newest becomes active) and publishes the event. */
    connect(integrationID, value) {
      addCredential(integrationID, value)
      emit({ type: "credential.updated", data: {} })
      emit({ type: "credential.switched", data: { integrationID } })
    },
    emit,
    subscribers,
    ...(events
      ? {
          event: {
            subscribe: ({ signal } = {}) => ({
              [Symbol.asyncIterator]() {
                const queue = []
                let wake
                const push = (event) => { queue.push(event); wake?.() }
                subscribers.add(push)
                const stop = () => { subscribers.delete(push); wake?.() }
                signal?.addEventListener("abort", stop, { once: true })
                return {
                  async next() {
                    for (;;) {
                      if (signal?.aborted) return { done: true, value: undefined }
                      if (queue.length > 0) return { done: false, value: queue.shift() }
                      await new Promise((resolve) => (wake = resolve))
                      wake = undefined
                    }
                  },
                  async return() { stop(); return { done: true, value: undefined } },
                }
              },
            }),
          },
        }
      : {}),
    tools: [],
    rpcs: [],
    tool: {
      transform: async (callback) => {
        const editor = { add: (tool) => host.tools.push(tool) }
        callback(editor)
        return { dispose: async () => undefined }
      },
    },
    rpc: {
      register: async (definition, handlers) => {
        // Real handlers always receive a call context with an AbortSignal.
        const withContext = Object.fromEntries(
          Object.entries(handlers).map(([name, handler]) => [name, (input, context = { signal: new AbortController().signal }) => handler(input, context)]),
        )
        host.rpcs.push({ definition, handlers: withContext, raw: handlers })
        return { dispose: async () => undefined, events: { emit: async () => undefined } }
      },
    },
  }
  return host
}

/** Real schema validation of every model the fold produced for a provider. */
export function decodeModels(record) {
  return [...record.models.values()].map((model) => Schema.decodeUnknownSync(Model.Info)(model))
}

export function decodeProvider(record) {
  return Schema.decodeUnknownSync(Provider.Info)(record.provider)
}

export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fake tool context: real tool executions always receive one with an AbortSignal. */
export function toolContext(signal = new AbortController().signal) {
  return { signal, sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test", progress: async () => undefined }
}

/** Waits until `predicate()` is truthy (polling the event loop), or fails after `ms`. */
export async function until(predicate, ms = 2000, label = "condition") {
  const end = Date.now() + ms
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await settle(10)
  }
}
