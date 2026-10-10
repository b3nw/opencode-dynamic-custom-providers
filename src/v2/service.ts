import type { Plugin } from "@opencode/plugin"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import type { IntegrationEditor } from "@opencode/plugin/promise/integration"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import { clearModelsDevCache, discoverAndEnrich, type DisplayStyle } from "./discover.js"
import { applyNativeModel, toNativeModels, type NativeModel } from "./model.js"
import type { PluginOptions } from "./options.js"
import { ConfigError, persistProvider, readProviders } from "./persist.js"
import type { AddProviderResult, ProviderStatus, RefreshResult } from "./rpc.js"
import { CancelledError, SafeError, checkBaseURL, displayURL, fingerprint, isHttpUrl, safeMessage, urlSecrets } from "./secure.js"

export type { AddProviderResult, ProviderStatus, RefreshResult } from "./rpc.js"

export const NATIVE_PACKAGE = "@opencode/ai/providers/openai-compatible"

/** Runtime packages this plugin knows how to discover for (core rewrites the AI SDK names to native). */
const COMPATIBLE_PACKAGES = new Set([
  "",
  NATIVE_PACKAGE,
  "@ai-sdk/openai-compatible",
  "aisdk:@ai-sdk/openai-compatible",
])

/** Providers with their own native discovery in OpenCode; only touched on explicit opt-in. */
const NATIVE_DISCOVERY = new Set(["ollama", "lmstudio", "vllm", "llama.cpp", "llamacpp"])

const PROVIDER_ID = /^[a-zA-Z0-9_-]+$/

/** Delay of the follow-up ownership re-check after a `config.updated` event. */
const CONFIG_SETTLE = 1_000

/** Upper bound for cleanup to wait on in-flight work (which is aborted first). */
const DISPOSE_TIMEOUT = 10_000

export type Host = Pick<Plugin.Context, "location" | "provider" | "integration" | "model"> & Partial<Pick<Plugin.Context, "event">>

/**
 * Who is asking. `user`: an interactive RPC client (TUI wizard), which is trusted to
 * choose endpoints and supply keys. `agent`: a model tool call, whose input may be
 * prompt-injected and is never trusted with credentials or new origins.
 */
export type Caller = "user" | "agent"

export interface CallOptions {
  readonly caller?: Caller
  readonly signal?: AbortSignal
}

export function legacyEnvName(providerID: string): string {
  return `OPENCODE_LOCAL_${providerID.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`
}

export function validateProviderId(providerID: string): string | null {
  if (!PROVIDER_ID.test(providerID)) return "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only."
  return null
}

export interface AddProviderInput {
  readonly providerID: string
  readonly baseURL: string
  readonly name?: string
  readonly apiKey?: string
  readonly overwrite?: boolean
}

/** What the host would authenticate a provider with; see `credentialIdentity`. */
interface CredentialTarget {
  readonly id: string
  readonly integrationID: string
  readonly settingsKey?: string
}

interface Candidate extends CredentialTarget {
  readonly baseURL: string
  readonly displayStyle: DisplayStyle
  /** Source identity: normalized base URL, runtime package and integration. */
  readonly source: string
}

/** Facts about every provider in the latest fold, eligible or not. */
interface Fact extends CredentialTarget {
  readonly baseURL?: string
  readonly package?: string
}

interface Inventory {
  readonly source: string
  /** Identity of the connection discovery authenticated with (never the secret itself). */
  credential: string
  readonly baseURL: string
  readonly models: readonly NativeModel[]
  readonly refreshedAt: number
}

/** A provider added in this session, injected until the host's config provides it. */
interface Pending {
  readonly baseURL: string
  readonly source: string
}

interface Reconcile {
  reload: boolean
  discover: boolean
  verify: boolean
  pending: boolean
  ownership: boolean
}

type Outcome =
  | { readonly ok: true; readonly candidate: Candidate; readonly identity: string; readonly models: NativeModel[] }
  | { readonly ok: false; readonly candidate: Candidate; readonly identity?: string; readonly message: string }

function stringSetting(settings: unknown, key: string): string | undefined {
  if (typeof settings !== "object" || settings === null) return undefined
  const value = (settings as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, "")
}

function sourceOf(baseURL: string, pkg: string | undefined, integrationID: string): string {
  // The transform fills a missing package with the native one, so both mean the same source.
  return JSON.stringify([normalizeBaseURL(baseURL), pkg || NATIVE_PACKAGE, integrationID])
}

function originOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return new URL(raw).origin
  } catch {
    return undefined
  }
}

function checkpoint(signal: AbortSignal) {
  if (signal.aborted) throw new CancelledError()
}

/**
 * Owns one plugin generation's discovery state. Transforms only replay the last
 * successful inventory for the exact provider source that produced it; network
 * discovery happens on startup, explicit refresh/add, and provider source or
 * connection changes — never on a timer.
 */
export function createService(host: Host, options: PluginOptions) {
  const inventory = new Map<string, Inventory>()
  const lastErrors = new Map<string, string>()
  // Eligible providers observed after the complete provider fold. Plugin fold order relative
  // to core's config provider plugin is not part of the contract, so candidates are observed
  // from the model transform (which always sees every provider transform's output).
  let candidates = new Map<string, Candidate>()
  let facts = new Map<string, Fact>()
  // Model IDs this plugin injected during the latest provider fold, per provider.
  let injected = new Map<string, Set<string>>()
  const pending = new Map<string, Pending>()
  // Inventory discovered by an update of an existing provider, applied once the host's
  // config reload actually switches that provider to the new source.
  const prepared = new Map<string, Inventory>()
  // `${id}\n${source}` pairs discovery ran for; cleared when a source changes or disappears.
  const attempted = new Set<string>()
  let observed = false
  // Ownership probe: a fold without any of this plugin's injections, so explicit config models
  // that share IDs with discovered ones become visible (see probeOwnership).
  let probing = false
  let probeSeen: ReturnType<typeof selectCandidates> | undefined
  let ownershipStale = false
  // Folds that happen while this plugin reloads the host are its own; others are external.
  let selfReloads = 0

  const lifetime = new AbortController()
  let queue: Promise<unknown> = Promise.resolve()
  const background = new Set<Promise<unknown>>()
  let flags: Reconcile = { reload: false, discover: false, verify: false, pending: false, ownership: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  let followUp: ReturnType<typeof setTimeout> | undefined

  const attemptKey = (candidate: Candidate) => `${candidate.id}\n${candidate.source}`

  function link(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
  }

  /** Runs operations one at a time. Work that is cancelled before or while running settles via `cancelled`. */
  function serialize<T>(signal: AbortSignal, run: () => Promise<T>, cancelled: () => T): Promise<T> {
    const start = () => (signal.aborted ? cancelled() : run())
    const next = queue.then(start, start).catch((error: unknown) => {
      if (signal.aborted || error instanceof CancelledError) return cancelled()
      throw error
    })
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    background.add(promise)
    promise.then(
      () => background.delete(promise),
      () => background.delete(promise),
    )
    return promise
  }

  function explicitModels(id: string, record: ProviderRecord): boolean {
    const ours = injected.get(id)
    for (const modelID of record.models.keys()) if (!ours?.has(modelID)) return true
    return false
  }

  function selectCandidates(records: readonly ProviderRecord[]) {
    const next = new Map<string, Candidate>()
    const known = new Map<string, Fact>()
    for (const record of records) {
      const id = record.provider.id as string
      const baseURL = stringSetting(record.provider.settings, "baseURL")
      const integrationID = (record.provider.integrationID as string | undefined) ?? id
      const settingsKey = stringSetting(record.provider.settings, "apiKey")
      const pkg = record.provider.package
      known.set(id, {
        id,
        integrationID,
        ...(baseURL ? { baseURL } : {}),
        ...(pkg ? { package: pkg } : {}),
        ...(settingsKey ? { settingsKey } : {}),
      })
      const opt = options.providers[id]
      if (opt?.discover === false) continue
      if (!baseURL || !isHttpUrl(baseURL)) continue
      if (!COMPATIBLE_PACKAGES.has(record.provider.package ?? "")) continue
      if (opt?.discover !== true) {
        if (NATIVE_DISCOVERY.has(id)) continue
        // Source models (catalog or explicit config models) mean the user owns the inventory.
        if (explicitModels(id, record)) continue
      }
      next.set(id, {
        id,
        baseURL,
        integrationID,
        ...(settingsKey ? { settingsKey } : {}),
        displayStyle: opt?.displayStyle ?? options.displayStyle,
        source: sourceOf(baseURL, record.provider.package, integrationID),
      })
    }
    return { next, known }
  }

  /** Forgets everything derived from a provider's previous source or connection. */
  function drop(id: string) {
    inventory.delete(id)
    lastErrors.delete(id)
    for (const key of [...attempted]) if (key.startsWith(`${id}\n`)) attempted.delete(key)
  }

  function retirePending(id: string) {
    pending.delete(id)
    drop(id)
  }

  /** Provider transform body. Must never throw: a throwing transform disables the plugin. */
  function transformProviders(editor: ProviderEditor) {
    const next = new Map<string, Set<string>>()
    try {
      if (lifetime.signal.aborted) return
      // The ownership probe folds without any injection to see what config alone provides.
      if (probing) {
        injected = next
        return
      }
      for (const [id, entry] of inventory) {
        const added = pending.get(id)
        if (added) {
          if (added.source !== entry.source) continue
          editor.update(id, (provider) => {
            if (!provider.package) provider.package = NATIVE_PACKAGE
            if (!stringSetting(provider.settings, "baseURL")) provider.settings = { ...provider.settings, baseURL: added.baseURL }
            provider.activation = "enabled"
          })
        } else {
          // Inventory is only ever replayed into the exact source that produced it.
          if (candidates.get(id)?.source !== entry.source) continue
          editor.update(id, (provider) => {
            if (!provider.package) provider.package = NATIVE_PACKAGE
          })
        }
        // The fold replays from initial state on every reload, so models missing from the
        // latest successful discovery are simply never re-added. Explicit config models and
        // late config model overrides keep their precedence.
        const ids = new Set<string>()
        for (const model of entry.models) {
          editor.models.update(id, model.id, (draft) => applyNativeModel(draft, model))
          ids.add(model.id)
        }
        next.set(id, ids)
      }
    } catch {
      // Keep the host's fold intact; status() surfaces discovery failures instead.
    }
    injected = next
  }

  /** Model transform: observation only. Never edits models, so config overrides stay last. */
  function observeModels(editor: ModelEditor) {
    try {
      if (lifetime.signal.aborted) return
      const selected = selectCandidates(editor.provider.list())
      if (probing) {
        probeSeen = selected
        return
      }
      const { next, known } = selected
      const external = selfReloads === 0
      const previous = candidates
      candidates = next
      facts = known
      observed = true
      const patch: Partial<Reconcile> = {}
      for (const [id, before] of previous) {
        const now = next.get(id)
        if (now && now.source === before.source) continue
        // Removed, ineligible, or a different source (URL, package, integration): never reuse.
        if (pending.has(id)) retirePending(id)
        else drop(id)
        if (prepared.get(id)?.source !== now?.source) prepared.delete(id)
        patch.reload = true
      }
      // New candidates need a reload so their connection methods (legacy env) are registered
      // before discovery resolves the connection execution will use.
      for (const id of next.keys()) if (!previous.has(id)) patch.reload = true
      for (const [id, entry] of [...prepared]) {
        const candidate = next.get(id)
        if (candidate?.source !== entry.source || inventory.has(id)) continue
        prepared.delete(id)
        inventory.set(id, entry)
        attempted.add(attemptKey(candidate))
        patch.reload = true
      }
      for (const [id, added] of pending) {
        // Config overrode the session addition (explicit models, other package or URL).
        if (next.get(id)?.source !== added.source) {
          retirePending(id)
          patch.reload = true
        }
      }
      for (const candidate of next.values()) if (!attempted.has(attemptKey(candidate))) patch.discover = true
      if (external && inventory.size > 0) patch.verify = true
      if (external && pending.size > 0) patch.pending = true
      // Config may now define models with the same IDs this plugin injects; only a fold without
      // the injections can tell (ID subtraction cannot).
      if (external && needsOwnershipProbe()) {
        ownershipStale = true
        patch.ownership = true
      }
      if (Object.keys(patch).length > 0) scheduleReconcile(patch)
    } catch {
      // See transformProviders.
    }
  }

  /** Ensures providers we manage expose key (and legacy env) connection methods. */
  function transformIntegrations(editor: IntegrationEditor) {
    try {
      if (lifetime.signal.aborted) return
      const ids = new Set([...candidates.keys(), ...pending.keys()])
      for (const id of ids) {
        const integrationID = candidates.get(id)?.integrationID ?? id
        const methods = editor.method.list(integrationID)
        if (!editor.get(integrationID) || !methods.some((method) => method.type === "key")) {
          editor.method.update({ integrationID, method: { type: "key", label: "API key" } })
        }
        if (!methods.some((method) => method.type === "env")) {
          editor.method.update({ integrationID, method: { type: "env", names: [legacyEnvName(id)] } })
        }
      }
    } catch {
      // See transformProviders.
    }
  }

  function scheduleReconcile(patch: Partial<Reconcile>) {
    if (lifetime.signal.aborted) return
    flags = {
      reload: flags.reload || patch.reload === true,
      discover: flags.discover || patch.discover === true,
      verify: flags.verify || patch.verify === true,
      pending: flags.pending || patch.pending === true,
      ownership: flags.ownership || patch.ownership === true,
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const run = flags
      flags = { reload: false, discover: false, verify: false, pending: false, ownership: false }
      void track(serialize(lifetime.signal, () => reconcile(run), () => undefined)).catch(() => undefined)
    }, 0)
  }

  async function reconcile(run: Reconcile) {
    const signal = lifetime.signal
    let reload = run.reload
    if (run.pending && pending.size > 0) reload = (await checkPendingConfig(signal)) || reload
    if (run.verify) reload = (await verifyConnections(signal)) || reload
    if (reload) await reloadHost(signal)
    await ensureOwnership(signal)
    await refreshLocked({ unattempted: true }, signal)
  }

  async function withSelfReload(run: () => Promise<void>) {
    selfReloads++
    try {
      await run()
    } finally {
      selfReloads--
    }
  }

  async function reloadHost(signal: AbortSignal) {
    checkpoint(signal)
    await withSelfReload(async () => {
      await host.integration.reload()
      checkpoint(signal)
      await host.provider.reload()
      checkpoint(signal)
      await host.model.reload()
      checkpoint(signal)
    })
  }

  // Host calls take no AbortSignal: an effect already issued completes; cancellation is
  // checked after every awaited effect so nothing further is started.
  async function ensureObserved(signal: AbortSignal) {
    if (observed) return
    checkpoint(signal)
    await withSelfReload(async () => {
      await host.provider.reload()
      checkpoint(signal)
      await host.model.reload()
      checkpoint(signal)
      if (!observed) await host.model.list()
      checkpoint(signal)
    })
  }

  /**
   * Session additions are retired as soon as the authoritative project config no longer
   * contains exactly what was written (deleted, other URL/package, explicit models).
   */
  async function checkPendingConfig(signal: AbortSignal): Promise<boolean> {
    let file: Record<string, unknown>
    try {
      file = await readProviders(host.location.directory)
    } catch {
      return false // Malformed mid-edit: decide on the next fold.
    }
    checkpoint(signal)
    let retired = false
    for (const [id, added] of [...pending]) {
      const entry = file[id]
      const settings = isRecord(entry) ? entry.settings : undefined
      const baseURL = stringSetting(settings, "baseURL")
      const pkg = isRecord(entry) && typeof entry.package === "string" ? entry.package : ""
      const models = isRecord(entry) && isRecord(entry.models) ? Object.keys(entry.models).length : 0
      const same =
        isRecord(entry) &&
        baseURL !== undefined &&
        normalizeBaseURL(baseURL) === added.baseURL &&
        COMPATIBLE_PACKAGES.has(pkg) &&
        (models === 0 || options.providers[id]?.discover === true)
      if (!same) {
        retirePending(id)
        retired = true
      }
    }
    return retired
  }

  /** Whether any injected provider's ownership depends on what config alone defines. */
  function needsOwnershipProbe(): boolean {
    if (pending.size > 0) return true
    for (const id of inventory.keys()) if (options.providers[id]?.discover !== true) return true
    return false
  }

  /** Runs the ownership probe if an external fold happened since the last one. */
  async function ensureOwnership(signal: AbortSignal) {
    if (!ownershipStale) return
    if (!needsOwnershipProbe()) {
      ownershipStale = false
      return
    }
    await probeOwnership(signal)
  }

  /**
   * Folds once without any injection: what remains is what the host's merged config (all
   * layers) and catalog define. A provider that is then ineligible (explicit models, even with
   * IDs this plugin discovered; other URL/package) is owned by config: its inventory is retired.
   * Session additions the config now supplies with the same source are acknowledged. Then the
   * remaining injections are restored. Until that second reload lands, managed models are
   * briefly absent from the host's lists. `decide` runs right after the injection-free fold is
   * applied, before the restoring reload, and with injections still off: a fold that lands during
   * its awaits is then another injection-free observation, never one where this plugin's injected
   * IDs hide explicit config models. `decide` calls `refresh` after each await to apply the latest
   * such fold before re-validating; one landing after `decide` is applied before injections return.
   */
  async function probeOwnership(signal: AbortSignal, decide?: (refresh: () => void) => Promise<void>) {
    checkpoint(signal)
    ownershipStale = false
    probeSeen = undefined
    probing = true
    let applied: ReturnType<typeof selectCandidates> | undefined
    const refresh = () => {
      const seen = probeSeen as ReturnType<typeof selectCandidates> | undefined
      if (!seen || seen === applied) return
      applied = seen
      applyProbe(seen)
    }
    try {
      await reloadHost(signal)
      refresh()
      // Without an observed fold, ownership could not be established: `decide` must fail closed.
      if (decide) await decide(refresh)
      refresh()
    } finally {
      probing = false
    }
    await reloadHost(signal)
  }

  function applyProbe(seen: ReturnType<typeof selectCandidates>) {
    const merged = new Map(seen.next)
    const mergedFacts = new Map(seen.known)
    for (const [id, added] of [...pending]) {
      if (seen.next.get(id)?.source === added.source) pending.delete(id)
      else if (seen.known.has(id)) retirePending(id)
      else {
        // Not in config yet: still a session addition.
        const candidate = candidates.get(id)
        const fact = facts.get(id)
        if (candidate) merged.set(id, candidate)
        if (fact) mergedFacts.set(id, fact)
      }
    }
    for (const [id, entry] of [...inventory]) {
      if (!pending.has(id) && merged.get(id)?.source !== entry.source) drop(id)
    }
    for (const id of [...prepared.keys()]) if (seen.known.has(id) && !seen.next.has(id)) prepared.delete(id)
    candidates = merged
    facts = mergedFacts
  }

  /** Drops inventory whose producing connection is no longer the one execution would use. */
  async function verifyConnections(signal: AbortSignal): Promise<boolean> {
    let dropped = false
    for (const [id, entry] of [...inventory]) {
      const candidate = candidates.get(id)
      if (!candidate) continue
      let identity: string
      try {
        identity = await credentialIdentity(candidate)
      } catch {
        identity = "unavailable"
      }
      checkpoint(signal)
      if (inventory.get(id) !== entry || identity === entry.credential) continue
      drop(id)
      lastErrors.set(id, `${id}: the active connection changed; models discovered with the previous connection were removed`)
      dropped = true
    }
    return dropped
  }

  /**
   * Identity of the credential OpenCode execution would use for a provider (2.0.21 model
   * resolver): the integration's active connection (newest stored credential, then env
   * methods), and only without one the configured `settings.apiKey`.
   */
  async function credentialIdentity(target: CredentialTarget): Promise<string> {
    let connection
    try {
      connection = await host.integration.connection.active(target.integrationID)
    } catch {
      throw new SafeError(`could not read the active connection for ${target.id}`, "credential")
    }
    if (connection?.type === "credential") return `credential:${connection.id}`
    if (connection?.type === "env") return `env:${connection.name}:${fingerprint(process.env[connection.name])}`
    if (target.settingsKey) return `settings:${fingerprint(target.settingsKey)}`
    return "none"
  }

  /** The key execution would send for a provider, with its identity. */
  async function executionCredential(target: CredentialTarget): Promise<{ identity: string; key?: string }> {
    const identity = await credentialIdentity(target)
    if (identity.startsWith("credential:") || identity.startsWith("env:")) {
      let credential
      try {
        const connection = await host.integration.connection.active(target.integrationID)
        credential = connection ? await host.integration.connection.resolve(connection) : undefined
      } catch {
        throw new SafeError(`could not resolve the active connection for ${target.id}`, "credential")
      }
      if (credential?.type === "key") return { identity, key: credential.key }
      if (credential) throw new SafeError(`${target.id} uses an OAuth connection, which model discovery does not support`, "credential")
    }
    return { identity, ...(target.settingsKey ? { key: target.settingsKey } : {}) }
  }

  function status(): ProviderStatus[] {
    const ids = new Set([...candidates.keys(), ...pending.keys()])
    return [...ids].sort().map((id) => {
      const entry = inventory.get(id)
      const baseURL = candidates.get(id)?.baseURL ?? pending.get(id)?.baseURL ?? ""
      const error = lastErrors.get(id)
      return {
        id,
        baseURL: baseURL ? displayURL(baseURL) : "",
        models: entry?.models.length ?? 0,
        modelIDs: entry?.models.map((model) => model.id) ?? [],
        ...(entry ? { refreshedAt: entry.refreshedAt } : {}),
        ...(error !== undefined ? { lastError: error } : {}),
        ...(pending.has(id) ? { pending: true } : {}),
      }
    })
  }

  async function discoverCandidate(candidate: Candidate, signal: AbortSignal): Promise<Outcome> {
    const secrets = [candidate.settingsKey, ...urlSecrets(candidate.baseURL)]
    let identity: string | undefined
    try {
      const credential = await executionCredential(candidate)
      identity = credential.identity
      secrets.push(credential.key)
      checkpoint(signal)
      const models = toNativeModels(
        await discoverAndEnrich(candidate.baseURL, {
          ...(credential.key ? { apiKey: credential.key } : {}),
          signal,
          displayStyle: candidate.displayStyle,
          secrets: secrets.filter((value): value is string => !!value),
        }),
      )
      return { ok: true, candidate, identity, models }
    } catch (error) {
      if (signal.aborted) throw new CancelledError()
      return { ok: false, candidate, ...(identity ? { identity } : {}), message: safeMessage(error, secrets) }
    }
  }

  function emptyRefresh(extra: Partial<RefreshResult> = {}): RefreshResult {
    return { providerCount: 0, totalModels: 0, failures: 0, updatedProviderIds: [], warnings: [], errors: [], providers: status(), ...extra }
  }

  function cancelledRefresh(): RefreshResult {
    return emptyRefresh({ errors: ["Cancelled: the request was aborted or the plugin was unloaded. Nothing was changed."], cancelled: true })
  }

  async function refreshLocked(
    input: { readonly providerID?: string; readonly clearCache?: boolean; readonly unattempted?: boolean },
    signal: AbortSignal,
  ): Promise<RefreshResult> {
    await ensureObserved(signal)
    // An explicit refresh always re-establishes config ownership (deterministic recovery path).
    if (!input.unattempted && needsOwnershipProbe()) ownershipStale = true
    await ensureOwnership(signal)
    const selected = [...candidates.values()].filter(
      (c) =>
        (!input.providerID || c.id === input.providerID) &&
        // Startup/reconcile discovery only covers sources never attempted in this generation.
        (!input.unattempted || !attempted.has(attemptKey(c))),
    )
    if (input.providerID && selected.length === 0 && !input.unattempted) {
      return emptyRefresh({ failures: 1, errors: [`Provider '${input.providerID}' is not eligible for dynamic discovery.`] })
    }
    if (selected.length === 0) return emptyRefresh()
    for (const candidate of selected) attempted.add(attemptKey(candidate))
    if (input.clearCache) clearModelsDevCache()

    const outcomes = await Promise.all(selected.map((candidate) => discoverCandidate(candidate, signal)))
    checkpoint(signal)
    // Config may have taken ownership meanwhile; outcomes for providers it now owns are discarded below.
    await ensureOwnership(signal)

    const warnings: string[] = []
    const errors: string[] = []
    const updated: string[] = []
    let failures = 0
    let totalModels = 0
    let changed = false
    for (const outcome of outcomes) {
      const { id, source } = outcome.candidate
      if (candidates.get(id)?.source !== source) {
        warnings.push(`${id} changed while it was being refreshed; the result was discarded`)
        continue
      }
      const previous = inventory.get(id)
      // Last-good models survive an outage only for the same source and connection.
      const keep = previous !== undefined && previous.source === source && outcome.identity !== undefined && previous.credential === outcome.identity
      if (previous && !keep && (!outcome.ok || outcome.models.length === 0)) {
        inventory.delete(id)
        changed = true
      }
      const kept = keep ? ` (keeping ${previous.models.length} previous model(s))` : previous ? " (previous models from another source or connection were removed)" : ""
      if (!outcome.ok) {
        failures++
        const message = `Failed to refresh ${id}: ${outcome.message}`
        lastErrors.set(id, message)
        errors.push(`${message}${kept}`)
        continue
      }
      if (outcome.models.length === 0) {
        const message = `${id} returned 0 models`
        lastErrors.set(id, message)
        warnings.push(keep ? `${message} (keeping previous models). Check endpoint status.` : `${message}${kept}`)
        continue
      }
      lastErrors.delete(id)
      inventory.set(id, {
        source,
        credential: outcome.identity,
        baseURL: outcome.candidate.baseURL,
        models: outcome.models,
        refreshedAt: Date.now(),
      })
      updated.push(id)
      totalModels += outcome.models.length
      changed = true
    }

    if (changed) await reloadHost(signal)
    return { providerCount: selected.length, totalModels, failures, updatedProviderIds: updated, warnings, errors, providers: status() }
  }

  function refresh(
    input: { readonly providerID?: string; readonly clearCache?: boolean; readonly unattempted?: boolean } = {},
    call: CallOptions = {},
  ): Promise<RefreshResult> {
    const signal = link(call.signal)
    return serialize(signal, () => refreshLocked(input, signal), cancelledRefresh)
  }

  /** Origins an agent may point a new provider at: configured dynamic providers plus `agentOrigins`. */
  function trustedOrigins(): Set<string> {
    const origins = new Set(options.agentOrigins)
    for (const candidate of candidates.values()) {
      const value = originOf(candidate.baseURL)
      if (value) origins.add(value)
    }
    return origins
  }

  /** Host-side identity of a provider: its folded source, eligibility and session addition. */
  function hostState(id: string): string {
    const fact = facts.get(id)
    return JSON.stringify([
      fact ? [fact.baseURL ? normalizeBaseURL(fact.baseURL) : null, fact.package ?? null, fact.integrationID, fingerprint(fact.settingsKey)] : null,
      candidates.get(id)?.source ?? null,
      pending.get(id)?.source ?? null,
    ])
  }

  async function addLocked(input: AddProviderInput, caller: Caller, signal: AbortSignal): Promise<AddProviderResult> {
    const idError = validateProviderId(input.providerID)
    if (idError) return { ok: false, code: "invalid", message: idError }
    const id = input.providerID
    const checked = checkBaseURL(normalizeBaseURL(input.baseURL))
    if (!checked.ok) return { ok: false, code: "invalid", message: checked.message }
    const baseURL = normalizeBaseURL(checked.url.href)
    const targetOrigin = checked.url.origin
    const opt = options.providers[id]
    if (opt?.discover === false) {
      return { ok: false, code: "invalid", message: `Dynamic discovery is disabled for '${id}' in the plugin options.` }
    }
    if (NATIVE_DISCOVERY.has(id) && opt?.discover !== true) {
      return { ok: false, code: "invalid", message: `'${id}' uses OpenCode's native model discovery. Opt in with the plugin option providers.${id}.discover = true.` }
    }
    if (caller === "agent" && input.apiKey) {
      return { ok: false, code: "invalid", message: "The agent tool does not accept API keys." }
    }

    await ensureObserved(signal)
    await ensureOwnership(signal)
    const directory = host.location.directory
    let file: Record<string, unknown>
    try {
      file = await readProviders(directory)
    } catch (error) {
      return { ok: false, code: "config_error", message: safeMessage(error) }
    }
    checkpoint(signal)
    const fact = facts.get(id)
    const exists = fact !== undefined || id in file || pending.has(id)
    if (exists && !input.overwrite) {
      return {
        ok: false,
        code: "duplicate",
        message: `A provider with ID '${id}' already exists. Set overwrite to true to update its base URL.`,
      }
    }
    const fileEntry = file[id]
    // What this operation was decided against: re-checked before every later side effect.
    const startState = hostState(id)
    // The eligible source the host folded at the start (an existing provider keeps it until
    // OpenCode reloads the config).
    const startSource = candidates.get(id)?.source
    const conflict = (): AddProviderResult => ({
      ok: false,
      code: "conflict",
      message: `'${id}' was changed, removed or taken over by config while its endpoint was being checked. Nothing was saved; review the config and try again.`,
    })
    const fileURL = isRecord(fileEntry) ? stringSetting(fileEntry.settings, "baseURL") : undefined
    // The origin the user already approved for this ID (its configured endpoint).
    const approved = originOf(candidates.get(id)?.baseURL ?? pending.get(id)?.baseURL ?? fact?.baseURL ?? fileURL)
    const target: CredentialTarget = {
      id,
      integrationID: candidates.get(id)?.integrationID ?? fact?.integrationID ?? id,
      ...(fact?.settingsKey ? { settingsKey: fact.settingsKey } : {}),
    }

    // Credential policy: a credential is only ever sent to the origin it is bound to.
    let apiKey: string | undefined
    let identity: string
    let viaLegacyEnv = false
    try {
      if (caller === "agent") {
        if (exists) {
          if (approved === undefined || approved !== targetOrigin) {
            return {
              ok: false,
              code: "approval_required",
              message: `Changing the endpoint origin of '${id}' needs user approval: ask the user to run /add-provider in the TUI. Nothing was contacted or saved.`,
            }
          }
          // Same approved origin: discovery uses exactly what execution already sends there.
          ;({ identity, key: apiKey } = await executionCredential(target))
        } else {
          if (!trustedOrigins().has(targetOrigin)) {
            return {
              ok: false,
              code: "approval_required",
              message:
                `${targetOrigin} is not an approved endpoint origin. Ask the user to run /add-provider in the TUI, ` +
                "or to list the origin under the plugin option agentOrigins. Nothing was contacted or saved.",
            }
          }
          identity = await credentialIdentity(target)
          if (identity !== "none" || process.env[legacyEnvName(id)]) {
            return {
              ok: false,
              code: "approval_required",
              message: `Credentials already exist for '${id}'; binding them to a new endpoint needs user approval. Ask the user to run /add-provider in the TUI. Nothing was contacted or saved.`,
            }
          }
        }
      } else if (input.apiKey) {
        apiKey = input.apiKey
        identity = `supplied:${fingerprint(apiKey)}`
      } else if (exists && approved !== targetOrigin) {
        identity = await credentialIdentity(target)
        if (identity !== "none") {
          return {
            ok: false,
            code: "approval_required",
            message:
              `The new base URL is on a different origin (${targetOrigin}) than the one approved for '${id}'` +
              `${approved ? ` (${approved})` : ""}. Existing credentials are never sent to a new origin: enter the API key again to authorize it.`,
          }
        }
      } else {
        ;({ identity, key: apiKey } = await executionCredential(target))
        if (!exists && apiKey === undefined && process.env[legacyEnvName(id)]) {
          // After adding, the registered legacy env method is what execution will use.
          apiKey = process.env[legacyEnvName(id)]
          identity = `env:${legacyEnvName(id)}:${fingerprint(apiKey)}`
          viaLegacyEnv = true
        }
      }
    } catch (error) {
      if (error instanceof CancelledError) throw error
      return { ok: false, code: "discovery_failed", message: `Failed to discover models: ${safeMessage(error)}` }
    }
    checkpoint(signal)

    const secrets = [apiKey, input.apiKey, target.settingsKey]
    let models: NativeModel[]
    try {
      models = toNativeModels(
        await discoverAndEnrich(baseURL, {
          ...(apiKey ? { apiKey } : {}),
          signal,
          displayStyle: opt?.displayStyle ?? options.displayStyle,
          secrets: secrets.filter((value): value is string => !!value),
        }),
      )
    } catch (error) {
      if (signal.aborted || error instanceof CancelledError) throw new CancelledError()
      const hint =
        error instanceof SafeError && /^HTTP 40[13]\b/.test(error.message) && !apiKey
          ? caller === "agent"
            ? " The endpoint requires authentication: ask the user to run /add-provider in the TUI."
            : " The endpoint requires authentication: enter its API key."
          : ""
      return { ok: false, code: "discovery_failed", message: `Failed to discover models: ${safeMessage(error, secrets)}.${hint}` }
    }
    if (models.length === 0) {
      return { ok: false, code: "discovery_failed", message: "No models found at the given endpoint. Provider not added." }
    }
    checkpoint(signal)
    // Discovery took time: the provider may have been deleted, edited or taken over meanwhile.
    await ensureOwnership(signal)
    if (hostState(id) !== startState) return conflict()

    let configPath: string
    try {
      const result = await persistProvider(
        directory,
        id,
        { name: input.name?.trim() || undefined, package: NATIVE_PACKAGE, baseURL },
        // The file entry must still be exactly what this operation started from.
        { overwrite: input.overwrite, signal, expect: { entry: fileEntry } },
      )
      configPath = result.path
    } catch (error) {
      if (error instanceof ConfigError && error.code === "duplicate") return { ok: false, code: "duplicate", message: error.message }
      if (error instanceof ConfigError && error.code === "changed") return conflict()
      if (signal.aborted || (error instanceof ConfigError && error.code === "cancelled")) throw new CancelledError()
      return { ok: false, code: "config_error", message: safeMessage(error, secrets) }
    }

    // Config is written. From here on, cancellation stops further side effects and says so.
    const saved = (step: string): AddProviderResult => ({
      ok: false,
      code: "cancelled",
      message: `Cancelled after '${id}' was saved to ${configPath}; ${step} OpenCode picks it up on its next config reload.`,
    })
    if (signal.aborted) return saved("the API key was not stored and models were not loaded.")
    const source = sourceOf(baseURL, NATIVE_PACKAGE, target.integrationID)
    const changedAfterSave = (): AddProviderResult => ({
      ok: false,
      code: "conflict",
      message: `'${id}' was saved to ${configPath}, but was changed or removed again before it was activated; the API key was not stored and the discovered models were not applied.`,
    })
    // Host state may only differ from the start by having folded this very write.
    const hostAgrees = () => {
      if (hostState(id) === startState) return true
      const fact = facts.get(id)
      const candidate = candidates.get(id)
      // Compared by URL: an existing provider keeps its own (compatible) package on update.
      return fact?.baseURL !== undefined && normalizeBaseURL(fact.baseURL) === baseURL && (!candidate || normalizeBaseURL(candidate.baseURL) === baseURL)
    }
    // The source of what was written: an existing entry keeps its own package (see persist).
    const savedSource = sourceOf(baseURL, isRecord(fileEntry) && typeof fileEntry.package === "string" ? fileEntry.package : NATIVE_PACKAGE, target.integrationID)
    /** Whether the project file still holds exactly the written source, without explicit models. */
    const fileSaved = async () => {
      try {
        const entry = (await readProviders(directory))[id]
        const savedURL = isRecord(entry) ? stringSetting(entry.settings, "baseURL") : undefined
        const pkg = isRecord(entry) && typeof entry.package === "string" ? entry.package : ""
        const explicit = isRecord(entry) && isRecord(entry.models) && Object.keys(entry.models).length > 0 && opt?.discover !== true
        return savedURL !== undefined && COMPATIBLE_PACKAGES.has(pkg) && sourceOf(savedURL, pkg, target.integrationID) === savedSource && !explicit
      } catch {
        return false
      }
    }
    const stillSaved = async () => (await fileSaved()) && hostAgrees()
    if (!(await stillSaved())) return changedAfterSave()
    if (signal.aborted) return saved("the API key was not stored and models were not loaded.")
    const entry: Inventory = { source, credential: identity, baseURL, models, refreshedAt: Date.now() }
    // A provider the host already has keeps its current source until OpenCode reloads the
    // config (core's config transform wins over plugin edits); its new inventory waits for
    // that switch. New providers are injected right away until config acknowledges them.
    const live = !fact || pending.has(id)
    if (live) {
      drop(id)
      prepared.delete(id)
      pending.set(id, { baseURL, source })
      attempted.add(`${id}\n${source}`)
      inventory.set(id, entry)
      try {
        await reloadHost(signal)
      } catch (error) {
        if (!(error instanceof CancelledError)) throw error
        return saved("the API key was not stored.")
      }
    } else {
      prepared.set(id, entry)
    }
    // Re-validate before storing a credential: never bind a key to a provider the user removed.
    if (!(await stillSaved())) {
      if (pending.get(id)?.source === source) retirePending(id)
      if (prepared.get(id) === entry) prepared.delete(id)
      try {
        if (live) await reloadHost(signal)
      } catch (error) {
        if (!(error instanceof CancelledError)) throw error
      }
      return changedAfterSave()
    }

    // Authoritative ownership: a fold without this plugin's injections shows what every config
    // layer defines now. The saved entry must still be this operation's own adoption (not owned
    // by explicit models in any layer, same source, integration and settings key) before models
    // are kept or a key is stored. The key is stored right after that fold, before injections
    // are restored, so no reload of this plugin's lies between the check and the credential.
    const settingsKey = fingerprint(target.settingsKey)
    const owns = (seen: boolean) => {
      const fact = facts.get(id)
      if (!seen || (fact?.integrationID ?? id) !== target.integrationID || fingerprint(fact?.settingsKey) !== settingsKey) return false
      if (!live) {
        // The authoritative eligible source must still be the one this update started from
        // (config not reloaded yet) or the one it saved (adopted); prepared identity alone is
        // not proof, since a layer can change an eligible provider's URL/package.
        const current = candidates.get(id)?.source
        return (prepared.get(id) === entry || inventory.get(id) === entry) && current !== undefined && (current === startSource || current === savedSource)
      }
      return inventory.get(id) === entry && (pending.get(id)?.source === source || candidates.get(id)?.source === source)
    }
    const warnings: string[] = []
    if (!live) warnings.push(`OpenCode switches '${id}' to the new base URL when it reloads the config.`)
    let credentialStored = false
    let owned = false
    let fileChanged = false
    let keyCancelled = false
    try {
      await probeOwnership(signal, async (refresh) => {
        const seen = probeSeen !== undefined
        if (!owns(seen)) return
        // The fold cannot show the project file itself: an entry the host has not adopted yet
        // looks the same whether it is still saved or was deleted/edited meanwhile. Re-read it,
        // then apply any injection-free fold that landed during the read (a config layer may
        // have taken the provider over meanwhile, even with model IDs this plugin discovered) and
        // re-validate everything the await could have let change (folds, pending, prepared
        // inventory) before deciding and issuing the key action. (`hostAgrees` does not apply
        // here: an injection-free fold lacks this plugin's package fill-in; `owns` compares
        // normalized sources.)
        const fileOK = await fileSaved()
        refresh()
        fileChanged = !fileOK
        owned = fileOK && owns(seen)
        if (!owned || caller !== "user" || !input.apiKey) return
        if (signal.aborted) {
          keyCancelled = true
          return
        }
        try {
          await host.integration.connect.key({ integrationID: target.integrationID, key: input.apiKey })
          credentialStored = true
        } catch (error) {
          // Never fall back to writing the key into config.
          warnings.push(
            `Provider saved, but the API key could not be stored (${safeMessage(error, secrets)}). ` +
              `Run /connect for '${id}' or set ${legacyEnvName(id)}.`,
          )
        }
      })
    } catch (error) {
      if (!(error instanceof CancelledError)) throw error
      return saved(credentialStored ? "the API key was stored, but models were not reloaded." : "the API key was not stored.")
    }
    if (!owned) {
      if (pending.get(id)?.source === source) retirePending(id)
      if (inventory.get(id) === entry) drop(id)
      if (prepared.get(id) === entry) prepared.delete(id)
      try {
        if (live) await reloadHost(signal)
      } catch (error) {
        if (!(error instanceof CancelledError)) throw error
      }
      if (fileChanged) return changedAfterSave()
      return {
        ok: false,
        code: "conflict",
        message: `'${id}' was saved to ${configPath}, but another config layer took it over (or changed it) before it was activated; the API key was not stored and the discovered models were not applied. The saved entry was left as written: review the config.`,
      }
    }
    if (keyCancelled) return saved("the API key was not stored.")
    // Bind the inventory to the connection execution will now use; a mismatch (e.g. the key
    // could not be stored) makes the next reconcile re-discover with the real one.
    if (credentialStored || viaLegacyEnv) {
      try {
        entry.credential = await credentialIdentity(target)
      } catch {
        // Verified again on the next reconcile.
      }
    }
    scheduleReconcile({ verify: true })

    return {
      ok: true,
      message: `Provider '${id}' ${exists ? "updated" : "added"} with ${models.length} model(s).`,
      modelCount: models.length,
      configPath,
      credentialStored,
      warnings,
    }
  }

  function addProvider(input: AddProviderInput, call: CallOptions = {}): Promise<AddProviderResult> {
    // Least privilege by default: only callers that say so are treated as the interactive user.
    const caller = call.caller ?? "agent"
    const signal = link(call.signal)
    return serialize(
      signal,
      () => addLocked(input, caller, signal),
      () => ({ ok: false, code: "cancelled", message: "Cancelled: the request was aborted or the plugin was unloaded. Nothing was saved." }),
    )
  }

  /**
   * OpenCode's config changed (any layer). Its own config plugin reloads in response, and that
   * fold may interleave with one of this plugin's reloads (where it would count as self), so
   * ownership is re-checked now and once more shortly after, independent of fold timing.
   */
  function configChanged() {
    const recheck = () => {
      if (lifetime.signal.aborted) return
      if (needsOwnershipProbe()) ownershipStale = true
      scheduleReconcile({ pending: pending.size > 0, verify: inventory.size > 0, ownership: true })
    }
    recheck()
    if (followUp) clearTimeout(followUp)
    followUp = setTimeout(() => {
      followUp = undefined
      recheck()
    }, CONFIG_SETTLE)
  }

  /** Re-checks providers when OpenCode reports a credential being added, switched or removed, or a config change. */
  function watchConnections() {
    const events = host.event
    if (!events?.subscribe) return
    void (async () => {
      try {
        for await (const event of events.subscribe({ signal: lifetime.signal })) {
          if (lifetime.signal.aborted) break
          const type = (event as { type?: unknown }).type
          if (type === "credential.updated" || type === "credential.switched") scheduleReconcile({ verify: true })
          if (type === "config.updated") configChanged()
        }
      } catch {
        // Stream unavailable or closed: explicit refresh still re-resolves the active connection.
      }
    })()
  }

  return {
    transformProviders,
    transformIntegrations,
    observeModels,
    refresh,
    addProvider,
    status,
    /** Starts the one startup discovery and credential change tracking. */
    start() {
      watchConnections()
      scheduleReconcile({ discover: true })
    },
    /** Status after any in-flight or queued work settles. */
    settledStatus: (call: CallOptions = {}) => {
      const signal = link(call.signal)
      return serialize(signal, async () => status(), status)
    },
    /**
     * Stops admission, aborts in-flight discovery, settles queued callers as cancelled,
     * and resolves once no further side effects can happen (bounded wait).
     */
    async dispose() {
      if (!lifetime.signal.aborted) lifetime.abort()
      if (timer) clearTimeout(timer)
      timer = undefined
      if (followUp) clearTimeout(followUp)
      followUp = undefined
      let bound: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([queue, ...background]),
        new Promise((resolve) => {
          bound = setTimeout(resolve, DISPOSE_TIMEOUT)
        }),
      ])
      if (bound) clearTimeout(bound)
    },
    get disposed() {
      return lifetime.signal.aborted
    },
  }
}

export type Service = ReturnType<typeof createService>
