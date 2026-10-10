import type { Rpc } from "@opencode/plugin/rpc"

/** Shared server/TUI contract. Plain data only, so the TUI can import it without server code. */
export const RPC_ID = "opencode-dynamic-custom-providers-v2"

// OpenCode 2.0.21 rejects JSON Schema `pattern` in RPC schemas ("patterns is set to error");
// provider IDs are validated by the server handler instead.
const providerID = { type: "string", minLength: 1, maxLength: 128 } as const
const strings = { type: "array", items: { type: "string" } } as const

const providerStatus = {
  type: "object",
  properties: {
    id: { type: "string" },
    baseURL: { type: "string" },
    models: { type: "integer", minimum: 0 },
    modelIDs: strings,
    refreshedAt: { type: "number" },
    lastError: { type: "string" },
    pending: { type: "boolean" },
  },
  required: ["id", "baseURL", "models", "modelIDs"],
  additionalProperties: false,
} as const

const refreshOutput = {
  type: "object",
  properties: {
    providerCount: { type: "integer", minimum: 0 },
    totalModels: { type: "integer", minimum: 0 },
    failures: { type: "integer", minimum: 0 },
    updatedProviderIds: strings,
    warnings: strings,
    errors: strings,
    providers: { type: "array", items: providerStatus },
    cancelled: { type: "boolean" },
  },
  required: ["providerCount", "totalModels", "failures", "updatedProviderIds", "warnings", "errors", "providers"],
  additionalProperties: false,
} as const

export const ADD_ERROR_CODES = ["invalid", "duplicate", "approval_required", "discovery_failed", "config_error", "conflict", "cancelled"] as const

const addOutput = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    code: { type: "string", enum: ADD_ERROR_CODES },
    message: { type: "string" },
    modelCount: { type: "integer", minimum: 0 },
    configPath: { type: "string" },
    credentialStored: { type: "boolean" },
    warnings: strings,
  },
  required: ["ok", "message"],
  additionalProperties: false,
} as const

export const DynamicProvidersRpc = {
  id: RPC_ID,
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { providers: { type: "array", items: providerStatus } },
        required: ["providers"],
        additionalProperties: false,
      },
    },
    refresh: {
      input: {
        type: "object",
        properties: { providerID },
        additionalProperties: false,
      },
      output: refreshOutput,
    },
    addProvider: {
      input: {
        type: "object",
        properties: {
          providerID,
          baseURL: { type: "string", minLength: 1, maxLength: 2048 },
          name: { type: "string", maxLength: 256 },
          apiKey: { type: "string", maxLength: 8192 },
          overwrite: { type: "boolean" },
        },
        required: ["providerID", "baseURL"],
        additionalProperties: false,
      },
      output: addOutput,
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export type DynamicProvidersRpc = typeof DynamicProvidersRpc

/** Secret-free per-provider state, safe to return over RPC and tool output. */
export interface ProviderStatus {
  readonly id: string
  readonly baseURL: string
  readonly models: number
  readonly modelIDs: readonly string[]
  readonly refreshedAt?: number
  readonly lastError?: string
  /** Added in this session and not yet acknowledged by a config reload. */
  readonly pending?: boolean
}

export interface RefreshResult {
  readonly providerCount: number
  readonly totalModels: number
  readonly failures: number
  readonly updatedProviderIds: readonly string[]
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
  readonly providers: readonly ProviderStatus[]
  readonly cancelled?: boolean
}

export type AddErrorCode = (typeof ADD_ERROR_CODES)[number]

export type AddProviderResult =
  | {
      readonly ok: true
      readonly message: string
      readonly modelCount: number
      readonly configPath: string
      readonly credentialStored: boolean
      readonly warnings: readonly string[]
    }
  | {
      readonly ok: false
      readonly code: AddErrorCode
      readonly message: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string")

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0

const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)

export function isProviderStatus(value: unknown): value is ProviderStatus {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.baseURL === "string" &&
    isCount(value.models) &&
    isStrings(value.modelIDs) &&
    optional(value.refreshedAt, (v) => typeof v === "number" && Number.isFinite(v)) &&
    optional(value.lastError, (v) => typeof v === "string") &&
    optional(value.pending, (v) => typeof v === "boolean")
  )
}

/**
 * Runtime narrowing for RPC results received by a client (the TUI). The output JSON
 * schemas above describe the union of both result shapes; these guards are the
 * discriminated check (success-only fields required on success, known code on failure).
 */
export function isRefreshResult(value: unknown): value is RefreshResult {
  return (
    isRecord(value) &&
    isCount(value.providerCount) &&
    isCount(value.totalModels) &&
    isCount(value.failures) &&
    isStrings(value.updatedProviderIds) &&
    isStrings(value.warnings) &&
    isStrings(value.errors) &&
    Array.isArray(value.providers) &&
    value.providers.every(isProviderStatus) &&
    optional(value.cancelled, (v) => typeof v === "boolean")
  )
}

export function isAddProviderResult(value: unknown): value is AddProviderResult {
  if (!isRecord(value) || typeof value.message !== "string") return false
  if (value.ok === true) {
    return isCount(value.modelCount) && typeof value.configPath === "string" && typeof value.credentialStored === "boolean" && isStrings(value.warnings)
  }
  return value.ok === false && typeof value.code === "string" && (ADD_ERROR_CODES as readonly string[]).includes(value.code)
}
