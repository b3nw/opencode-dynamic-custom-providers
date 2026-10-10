import type { Model } from "@opencode/plugin"
import type { DeepMutable } from "@opencode/plugin/promise/types"
import type { EnrichedModel } from "./discover.js"

type MutableModel = DeepMutable<Model.Info>

const STATUSES = new Set(["alpha", "beta", "deprecated", "active"])

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 4096

/** Plain, secret-free model definition derived from a successful discovery. */
export interface NativeModel {
  readonly id: string
  readonly name: string
  readonly family?: string
  readonly capabilities: {
    readonly tools: boolean
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly limit: {
    readonly context: number
    readonly input?: number
    readonly output: number
  }
  readonly cost: ReadonlyArray<{
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  }>
  readonly released: number
  readonly status: "alpha" | "beta" | "deprecated" | "active"
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function modalities(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const result = [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
  return result.length > 0 ? result : [...fallback]
}

/**
 * Converts the V1 enrichment shape into V2 native model fields. V1-only fields
 * (reasoning, temperature, attachment) have no V2 schema equivalent and are dropped.
 */
export function toNativeModel(id: string, model: EnrichedModel): NativeModel | undefined {
  // `#` separates variants in V2 model references; sanitizeModelId already removes it.
  if (!id || id.includes("#") || id.trim() !== id) return undefined

  const input = modalities(model.modalities?.input, ["text"])
  const output = modalities(model.modalities?.output, ["text"])

  const context = positiveInt(model.limit?.context) ?? DEFAULT_CONTEXT
  const limitInput = positiveInt(model.limit?.input)
  const limitOutput = positiveInt(model.limit?.output) ?? DEFAULT_OUTPUT

  const cost: NativeModel["cost"][number][] = []
  if (model.cost) {
    const costInput = finiteNonNegative(model.cost.input)
    const costOutput = finiteNonNegative(model.cost.output)
    if (costInput !== undefined && costOutput !== undefined) {
      cost.push({
        input: costInput,
        output: costOutput,
        cache: {
          read: finiteNonNegative(model.cost.cache_read) ?? 0,
          write: finiteNonNegative(model.cost.cache_write) ?? 0,
        },
      })
    }
  }

  const released = model.release_date ? Date.parse(model.release_date) : Number.NaN
  const status = typeof model.status === "string" && STATUSES.has(model.status)
    ? (model.status as NativeModel["status"])
    : "active"

  return {
    id,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : id,
    ...(typeof model.family === "string" && model.family.length > 0 ? { family: model.family } : {}),
    capabilities: { tools: model.tool_call === true, input, output },
    limit: {
      context,
      ...(limitInput !== undefined ? { input: limitInput } : {}),
      output: limitOutput,
    },
    cost,
    released: Number.isFinite(released) ? released : 0,
    status,
  }
}

export function toNativeModels(models: Record<string, EnrichedModel>): NativeModel[] {
  const result: NativeModel[] = []
  for (const [id, model] of Object.entries(models)) {
    const native = toNativeModel(id, model)
    if (native) result.push(native)
  }
  return result
}

/**
 * Writes discovered fields onto a host-created draft (which already carries the
 * native defaults from `Model.Info.default`). Identity fields are owned by the host.
 */
export function applyNativeModel(draft: MutableModel, model: NativeModel): void {
  draft.modelID = model.id as Model.Info["modelID"]
  draft.name = model.name
  // Optional schema fields are exact: an explicit `undefined` fails Model.Info decoding.
  if (model.family === undefined) delete draft.family
  else draft.family = model.family as NonNullable<Model.Info["family"]>
  draft.capabilities = {
    tools: model.capabilities.tools,
    input: [...model.capabilities.input],
    output: [...model.capabilities.output],
  }
  draft.limit = {
    context: model.limit.context,
    ...(model.limit.input !== undefined ? { input: model.limit.input } : {}),
    output: model.limit.output,
  }
  draft.cost = model.cost.map((cost) => ({
    input: cost.input as Model.Info["cost"][number]["input"],
    output: cost.output as Model.Info["cost"][number]["output"],
    cache: {
      read: cost.cache.read as Model.Info["cost"][number]["cache"]["read"],
      write: cost.cache.write as Model.Info["cost"][number]["cache"]["write"],
    },
  }))
  draft.time = { released: model.released }
  draft.status = model.status
  draft.enabled = true
}
