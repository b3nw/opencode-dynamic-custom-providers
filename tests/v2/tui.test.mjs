import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import tui, { id as tuiID } from "../../packages/v2/dist/v2/tui.js"
import { RPC_ID } from "../../packages/v2/dist/v2/rpc.js"
import { assertNoSecret } from "./helpers.mjs"

function createContext({ prompts = [], confirms = [], responses = {}, location = { directory: "/remote/project" }, noLocation = false } = {}) {
  const layers = []
  const toasts = []
  const calls = []
  const claims = []
  const released = []
  let rendering = false
  const ctx = {
    options: {},
    location: noLocation ? undefined : location,
    keymap: {
      // Mirrors 2.0.21: layers must be created while a component renders.
      layer: (factory) => {
        if (!rendering) throw new Error("Keymap.Provider is missing")
        layers.push(factory())
      },
    },
    ui: {
      slot: (claim) => {
        claims.push(claim)
        rendering = true
        try {
          const element = claim.render({})
          if (element !== null) throw new Error("command claim must render nothing")
        } finally {
          rendering = false
        }
        return () => released.push(claim)
      },
      toast: { show: (options) => toasts.push(options) },
      dialog: {
        prompt: async (options) => {
          calls.push({ type: "prompt", title: options.title, description: options.description, placeholder: options.placeholder })
          return prompts.shift()
        },
        confirm: async (options) => {
          calls.push({ type: "confirm", title: options.title })
          return confirms.shift()
        },
      },
    },
    client: {
      rpc: (definition) => {
        assert.equal(definition.id, RPC_ID)
        const method = (name) => async (input, options) => {
          calls.push({ type: "rpc", name, input, options })
          const queue = responses[name]
          const next = Array.isArray(queue) ? queue.shift() : queue
          if (next instanceof Error) throw next
          if (typeof next === "object" && next?.throw) throw next.throw
          return next
        }
        return { status: method("status"), refresh: method("refresh"), addProvider: method("addProvider") }
      },
    },
  }
  return { ctx, layers, toasts, calls, claims, released }
}

function command(layers, slash) {
  assert.equal(layers.length, 1)
  const found = layers[0].commands.find((c) => c.slash?.name === slash)
  assert.ok(found, `command /${slash}`)
  return found
}

test("default export is a V2 TUI definition { id, setup } registering one keymap layer from a mounted slot", async () => {
  assert.equal(tui.id, tuiID)
  assert.equal(typeof tui.setup, "function")
  const { ctx, layers, claims, released } = createContext()
  const cleanup = await tui.setup(ctx)
  assert.equal(claims.length, 1)
  assert.equal(claims[0].append, "app")
  assert.equal(typeof claims[0].render, "function")
  assert.equal(layers.length, 1)
  assert.equal(layers[0].mode, "global")
  const commands = layers[0].commands
  assert.deepEqual(commands.map((c) => c.id), ["dynamic-providers.add", "dynamic-providers.reload"])
  assert.deepEqual(commands.map((c) => c.slash), [{ name: "add-provider" }, { name: "reload-models", aliases: ["refresh-models"] }])
  for (const c of commands) {
    assert.equal(c.palette, true)
    assert.equal(typeof c.run, "function")
  }
  await cleanup()
  assert.equal(released.length, 1, "slot claim released on cleanup")
})

test("calling keymap.layer outside a render fails like the real host (regression for setup-time registration)", () => {
  const { ctx } = createContext()
  assert.throws(() => ctx.keymap.layer(() => ({ commands: [] })), /Keymap.Provider is missing/)
})

test("each setup generation registers exactly one layer (no duplicate commands)", async () => {
  for (let i = 0; i < 3; i++) {
    const { ctx, layers } = createContext()
    await tui.setup(ctx)
    assert.equal(layers.length, 1)
  }
})

test("/add-provider wizard routes discovery+persist to the server with explicit location", async () => {
  const { ctx, layers, toasts, calls } = createContext({
    prompts: [" my-proxy ", "https://api.example.com/v1", "sk-test-wizard"],
    responses: { addProvider: { ok: true, message: "Provider 'my-proxy' added with 3 model(s).", modelCount: 3, configPath: "/remote/project/opencode.jsonc", credentialStored: true, warnings: [] } },
  })
  await tui.setup(ctx)
  await command(layers, "add-provider").run()
  const rpcCalls = calls.filter((c) => c.type === "rpc")
  assert.equal(rpcCalls.length, 1)
  assert.deepEqual(rpcCalls[0].input, { providerID: "my-proxy", baseURL: "https://api.example.com/v1", apiKey: "sk-test-wizard" })
  assert.deepEqual(rpcCalls[0].options, { location: { directory: "/remote/project" } })
  assert.equal(toasts.at(-1).variant, "success")
  assertNoSecret(toasts, "toasts")
})

test("/add-provider duplicate asks to confirm overwrite; confirm retries with overwrite", async () => {
  const { ctx, layers, calls, toasts } = createContext({
    prompts: ["dup", "http://127.0.0.1:1/v1", ""],
    confirms: [true],
    responses: {
      addProvider: [
        { ok: false, code: "duplicate", message: "exists" },
        { ok: true, message: "Provider 'dup' updated with 1 model(s).", modelCount: 1, configPath: "/remote/project/opencode.jsonc", credentialStored: false, warnings: [] },
      ],
    },
  })
  await tui.setup(ctx)
  await command(layers, "add-provider").run()
  const rpcCalls = calls.filter((c) => c.type === "rpc")
  assert.equal(rpcCalls.length, 2)
  assert.equal("apiKey" in rpcCalls[0].input, false, "empty key is not sent")
  assert.equal(rpcCalls[1].input.overwrite, true)
  // Update outcome only: the success toast, never a cancellation.
  assert.equal(toasts.at(-1).variant, "success")
  assert.match(toasts.at(-1).message, /^Provider 'dup' updated with 1 model\(s\)\./)
  assert.equal(toasts.some((t) => /cancel/i.test(`${t.title ?? ""} ${t.message}`)), false)
})

test("/add-provider duplicate cancel performs no further calls", async () => {
  const { ctx, layers, calls, toasts } = createContext({
    prompts: ["dup", "http://127.0.0.1:1/v1", ""],
    confirms: [false],
    responses: { addProvider: [{ ok: false, code: "duplicate", message: "exists" }] },
  })
  await tui.setup(ctx)
  await command(layers, "add-provider").run()
  assert.equal(calls.filter((c) => c.type === "rpc").length, 1)
  assert.match(toasts.at(-1).message, /cancelled/)
})

test("/add-provider cancel at any prompt or invalid input makes no RPC call", async () => {
  for (const prompts of [[undefined], ["ok", undefined], ["ok", "https://x.test/v1", undefined], ["bad id!"], ["ok", "not-a-url"]]) {
    const { ctx, layers, calls } = createContext({ prompts: [...prompts] })
    await tui.setup(ctx)
    await command(layers, "add-provider").run()
    assert.equal(calls.filter((c) => c.type === "rpc").length, 0, JSON.stringify(prompts))
  }
})

test("/add-provider surfaces server failures and RPC errors as error toasts", async () => {
  const failing = createContext({
    prompts: ["p", "https://x.test/v1", ""],
    responses: { addProvider: { ok: false, code: "discovery_failed", message: "Failed to discover models: HTTP 401" } },
  })
  await tui.setup(failing.ctx)
  await command(failing.layers, "add-provider").run()
  assert.equal(failing.toasts.at(-1).variant, "error")
  assert.match(failing.toasts.at(-1).message, /HTTP 401/)

  const unavailable = createContext({
    prompts: ["p", "https://x.test/v1", ""],
    responses: { addProvider: { throw: { type: "rpc.unavailable", message: "RPC is unavailable" } } },
  })
  await tui.setup(unavailable.ctx)
  await command(unavailable.layers, "add-provider").run()
  assert.match(unavailable.toasts.at(-1).message, /RPC is unavailable/)
})

test("/reload-models calls refresh over RPC and reports counts", async () => {
  const { ctx, layers, calls, toasts } = createContext({
    noLocation: true,
    responses: { refresh: { providerCount: 1, totalModels: 4, failures: 0, updatedProviderIds: ["p"], warnings: [], errors: [], providers: [] } },
  })
  await tui.setup(ctx)
  await command(layers, "reload-models").run()
  const rpcCall = calls.find((c) => c.type === "rpc")
  assert.equal(rpcCall.name, "refresh")
  assert.equal(rpcCall.options, undefined)
  assert.match(toasts.at(-1).message, /Reloaded 4 model\(s\) from 1 provider/)
  assert.equal(toasts.at(-1).variant, "success")
})

test("the emitted TUI module has no filesystem, server or network imports", async () => {
  const source = await fs.readFile(new URL("../../packages/v2/dist/v2/tui.js", import.meta.url), "utf8")
  const imports = [...source.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1])
  assert.deepEqual(imports, ["./rpc.js"])
  const rpcSource = await fs.readFile(new URL("../../packages/v2/dist/v2/rpc.js", import.meta.url), "utf8")
  assert.equal(/^import /m.test(rpcSource), false)
  assert.equal(/fetch\(|node:fs/.test(source), false)
})

test("the API key prompt warns, before typing, that input is not masked (2.0.21 prompt has no mask option)", async () => {
  const { ctx, layers, calls } = createContext({ prompts: ["p", "https://x.test/v1", undefined] })
  await tui.setup(ctx)
  await command(layers, "add-provider").run()
  const keyPrompt = calls.filter((c) => c.type === "prompt")[2]
  assert.match(keyPrompt.title, /NOT masked/)
  assert.match(keyPrompt.description, /plain text on screen/)
  assert.doesNotMatch(keyPrompt.placeholder, /sk-/)
  assert.doesNotMatch(`${keyPrompt.title} ${keyPrompt.description}`, /\/connect (masks|is masked|hides)/, "no promise about other UIs masking")
})

test("/add-provider shows approval-required and malformed server results as errors", async () => {
  const approval = createContext({
    prompts: ["p", "https://x.test/v1", ""],
    responses: { addProvider: { ok: false, code: "approval_required", message: "enter the API key again to authorize it" } },
  })
  await tui.setup(approval.ctx)
  await command(approval.layers, "add-provider").run()
  assert.equal(approval.toasts.at(-1).variant, "error")
  assert.match(approval.toasts.at(-1).message, /enter the API key again/)

  const malformed = createContext({ prompts: ["p", "https://x.test/v1", ""], responses: { addProvider: { ok: true } } })
  await tui.setup(malformed.ctx)
  await command(malformed.layers, "add-provider").run()
  assert.equal(malformed.toasts.at(-1).variant, "error")
  assert.match(malformed.toasts.at(-1).message, /unexpected response/)
})

test("/reload-models reports a cancelled refresh as a warning", async () => {
  const { ctx, layers, toasts } = createContext({
    responses: { refresh: { providerCount: 0, totalModels: 0, failures: 0, updatedProviderIds: [], warnings: [], errors: ["Cancelled: aborted"], providers: [], cancelled: true } },
  })
  await tui.setup(ctx)
  await command(layers, "reload-models").run()
  assert.equal(toasts.at(-1).variant, "warning")
  assert.match(toasts.at(-1).message, /Cancelled/)
})
