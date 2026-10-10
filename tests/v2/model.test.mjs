import { test } from "node:test"
import assert from "node:assert/strict"
import { toNativeModel, toNativeModels, applyNativeModel } from "../../packages/v2/dist/v2/model.js"
import { Model, Schema } from "./helpers.mjs"

function apply(id, enriched, providerID = "proxy") {
  const native = toNativeModel(id, enriched)
  assert.ok(native, `expected ${id} to convert`)
  const draft = Model.Info.default(providerID, id)
  applyNativeModel(draft, native)
  return Schema.decodeUnknownSync(Model.Info)(draft)
}

test("unknown models default to tools=false and text-only, overriding V2 native defaults", () => {
  const model = apply("mystery-model", { name: "mystery-model", limit: { context: 128000, output: 4096 } })
  assert.equal(model.capabilities.tools, false)
  assert.deepEqual(model.capabilities.input, ["text"])
  assert.deepEqual(model.capabilities.output, ["text"])
  assert.deepEqual(model.cost, [])
  assert.equal(model.time.released, 0)
  assert.equal(model.status, "active")
  assert.equal(model.enabled, true)
  assert.deepEqual(model.limit, { context: 128000, output: 4096 })
})

test("known metadata maps limits, costs with cache, release time, modalities and status", () => {
  const model = apply("openai/gpt-4o", {
    name: "GPT-4o",
    family: "gpt",
    release_date: "2024-05-13",
    status: "beta",
    tool_call: true,
    reasoning: true,
    temperature: true,
    attachment: true,
    cost: { input: 2.5, output: 10, cache_read: 1.25 },
    limit: { context: 128000, input: 120000, output: 16384 },
    modalities: { input: ["text", "image"], output: ["text"] },
  })
  assert.equal(model.name, "GPT-4o")
  assert.equal(model.family, "gpt")
  assert.equal(model.modelID, "openai/gpt-4o")
  assert.equal(model.capabilities.tools, true)
  assert.deepEqual(model.capabilities.input, ["text", "image"])
  assert.deepEqual(model.limit, { context: 128000, input: 120000, output: 16384 })
  assert.deepEqual(model.cost, [{ input: 2.5, output: 10, cache: { read: 1.25, write: 0 } }])
  assert.equal(model.time.released, Date.parse("2024-05-13"))
  assert.equal(model.status, "beta")
  // V1-only fields are not forced into the V2 schema.
  for (const key of ["reasoning", "temperature", "attachment", "tool_call", "release_date", "modalities"]) {
    assert.equal(key in model, false, `${key} must not be present`)
  }
})

test("full slash-containing model IDs survive and parse as V2 model references", () => {
  const model = apply("meta-llama/llama-3.1-8b-instruct", { name: "x", limit: { context: 1, output: 1 } })
  assert.equal(model.id, "meta-llama/llama-3.1-8b-instruct")
  const ref = Model.Ref.parse(`proxy/${model.id}`)
  assert.equal(ref.providerID, "proxy")
  assert.equal(ref.id, "meta-llama/llama-3.1-8b-instruct")
})

test("missing or invalid metadata falls back to safe values", () => {
  const model = apply("broken", {
    name: "",
    release_date: "not a date",
    status: "retired",
    cost: { input: Number.NaN, output: 1 },
    limit: { context: -5, output: 0.5 },
    modalities: { input: [], output: [42] },
  })
  assert.equal(model.name, "broken")
  assert.equal(model.time.released, 0)
  assert.equal(model.status, "active")
  assert.deepEqual(model.cost, [])
  assert.deepEqual(model.limit, { context: 128000, output: 4096 })
  assert.deepEqual(model.capabilities.input, ["text"])
  assert.deepEqual(model.capabilities.output, ["text"])
})

test("invalid IDs are skipped instead of producing broken references", () => {
  assert.equal(toNativeModel("", { name: "x", limit: { context: 1, output: 1 } }), undefined)
  assert.equal(toNativeModel("a#variant", { name: "x", limit: { context: 1, output: 1 } }), undefined)
  assert.equal(toNativeModel(" padded", { name: "x", limit: { context: 1, output: 1 } }), undefined)
  const list = toNativeModels({
    good: { name: "good", limit: { context: 1, output: 1 } },
    "bad#x": { name: "bad", limit: { context: 1, output: 1 } },
  })
  assert.deepEqual(list.map((m) => m.id), ["good"])
})
