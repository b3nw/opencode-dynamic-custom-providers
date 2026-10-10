import * as fs from "node:fs/promises"
import { readFileSync, readlinkSync } from "node:fs"
import { hostname } from "node:os"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { SafeError } from "./secure.js"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

/** V2 project config names, in the order OpenCode prefers when both exist (`.jsonc` wins). */
export const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const
const DEFAULT_CONFIG_NAME = "opencode.jsonc"

export class ConfigError extends SafeError {
  constructor(
    message: string,
    override readonly code: "malformed" | "duplicate" | "invalid" | "conflict" | "changed" | "busy" | "cancelled",
  ) {
    super(message, code)
    this.name = "ConfigError"
  }
}

/** Secret-free provider entry written under `providers.<id>`. */
export interface PersistedProvider {
  readonly name?: string
  readonly package: string
  readonly baseURL: string
}

export interface PersistResult {
  readonly path: string
  readonly created: boolean
  readonly replaced: boolean
}

const FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } }
const MAX_ATTEMPTS = 5
const LOCK_TIMEOUT = 10_000

// Serializes read-modify-write per canonical config file within this process. Keys are
// real paths, so directory aliases and symlinked configs share one lock.
const locks = new Map<string, Promise<unknown>>()

async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.then(() => undefined, () => undefined)
  locks.set(key, settled)
  try {
    return await next
  } finally {
    if (locks.get(key) === settled) locks.delete(key)
  }
}

function lockPath(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.lock`)
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new ConfigError("Cancelled before the config was written", "cancelled")
}

interface LockOwner {
  readonly pid?: unknown
  readonly host?: unknown
  readonly boot?: unknown
  readonly pidns?: unknown
  readonly start?: unknown
  readonly token?: unknown
}

function readOptional(read: () => string): string | undefined {
  try {
    return read().trim() || undefined
  } catch {
    return undefined
  }
}

// Linux identity of this boot and PID namespace: PIDs are only comparable within both.
const BOOT_ID = readOptional(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8"))
const PID_NS = readOptional(() => readlinkSync("/proc/self/ns/pid"))

/** Process start time (Linux `/proc/<pid>/stat` field 22), to detect PID reuse. */
function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

/**
 * Whether a lock's owner can be proven gone. Age is never evidence: a stalled owner may
 * resume. Owners on another host or in another PID namespace (containers sharing a hostname),
 * or unidentifiable ones, are never judged from here. A live PID — including this process's
 * own — keeps its lock unless it now belongs to a process started at another time.
 */
function ownerIsDead(owner: LockOwner): boolean {
  if (typeof owner.pid !== "number" || typeof owner.token !== "string") return false
  if (owner.host !== hostname()) return false
  if (typeof owner.boot === "string" && BOOT_ID !== undefined && owner.boot !== BOOT_ID) return true // Rebooted since.
  if (owner.pidns !== PID_NS) return false
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
  const start = processStart(owner.pid)
  return typeof owner.start === "string" && start !== undefined && start !== owner.start
}

/** Creates the lock file with its full content in one step (link of a staged file), or reports EEXIST. */
async function createLock(lock: string, content: string): Promise<boolean> {
  const staged = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await fs.writeFile(staged, content, { mode: 0o600, flag: "wx" })
  try {
    await fs.link(staged, lock)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") return false
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EOPNOTSUPP") throw error
    // No hard links: exclusive create, then content (a crash in between leaves an unidentifiable lock).
    try {
      await fs.writeFile(lock, content, { mode: 0o600, flag: "wx" })
      return true
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code === "EEXIST") return false
      throw inner
    }
  } finally {
    await fs.unlink(staged).catch(() => undefined)
  }
}

/**
 * Removes a dead owner's lock, serialized among breakers by an exclusive `<lock>.break` marker.
 * Under the marker the lock is re-read and unlinked only if it is still exactly `observed`. That
 * cannot remove a live lock: a lock file is only ever removed by its own (live) owner on release,
 * or by the one breaker holding the marker after it re-read the dead owner's record — a dead owner
 * releases nothing, so that record cannot be replaced in between. The marker is never broken
 * automatically: one left by a crashed breaker blocks dead-lock recovery (the caller reports busy)
 * until it is removed by hand. Returns false when another breaker holds the marker.
 */
async function breakDeadLock(lock: string, observed: string): Promise<boolean> {
  const marker = `${lock}.break`
  try {
    await (await fs.open(marker, "wx", 0o600)).close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
  try {
    if ((await fs.readFile(lock, "utf8").catch(() => undefined)) === observed) await fs.unlink(lock).catch(() => undefined)
  } finally {
    await fs.unlink(marker)
  }
  return true
}

interface HeldLock {
  /** Throws `busy` unless the lock file still carries this holder's token. */
  readonly verify: () => Promise<void>
}

/**
 * Cross-process advisory lock next to the canonical config file (`.opencode.jsonc.lock`).
 * Only cooperating writers (this plugin, in any process) take it. A lock is broken only when
 * its owner is provably dead on this host (PID gone or reused, or the host rebooted since), and
 * only through `breakDeadLock`, which never removes a live owner's lock; a live owner is waited
 * for until the timeout, however old its lock. Holders verify they still own the lock
 * immediately before committing (against non-cooperating interference), and release only a lock
 * carrying their token.
 */
async function withFileLock<T>(
  file: string,
  signal: AbortSignal | undefined,
  timeout: number,
  run: (held: HeldLock) => Promise<T>,
): Promise<T> {
  const lock = lockPath(file)
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`
  const start = processStart(process.pid)
  const content = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    ...(BOOT_ID ? { boot: BOOT_ID } : {}),
    ...(PID_NS ? { pidns: PID_NS } : {}),
    ...(start ? { start } : {}),
    token,
    time: Date.now(),
  })
  const deadline = Date.now() + timeout
  for (;;) {
    throwIfAborted(signal)
    if (await createLock(lock, content)) break
    const observed = await fs.readFile(lock, "utf8").catch(() => undefined)
    let owner: LockOwner | undefined
    try {
      owner = observed === undefined ? undefined : (JSON.parse(observed) as LockOwner)
    } catch {
      owner = undefined // Unidentifiable: never broken automatically.
    }
    const dead = observed !== undefined && owner !== undefined && ownerIsDead(owner)
    if (dead && (await breakDeadLock(lock, observed))) continue
    if (Date.now() > deadline) {
      throw new ConfigError(
        dead
          ? `Config ${file} is locked by a writer that is no longer running (${lock}), and another recovery is in progress or was interrupted (${lock}.break); try again. If no writer is running, remove both files.`
          : `Config ${file} is locked by another writer (${lock}); try again. If no writer is running, remove that lock file.`,
        "busy",
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)))
  }
  const ours = (current: string | undefined) => {
    try {
      return current !== undefined && (JSON.parse(current) as LockOwner).token === token
    } catch {
      return false
    }
  }
  const verify = async () => {
    if (!ours(await fs.readFile(lock, "utf8").catch(() => undefined))) {
      throw new ConfigError(`Lost the lock on ${file} to another writer; nothing was written. Try again.`, "busy")
    }
  }
  try {
    return await run({ verify })
  } finally {
    if (ours(await fs.readFile(lock, "utf8").catch(() => undefined))) await fs.unlink(lock).catch(() => undefined)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

/** Resolves the project config file this plugin owns writes to: `<directory>/opencode.json(c)`. */
export async function resolveConfigPath(directory: string): Promise<{ path: string; exists: boolean }> {
  if (!path.isAbsolute(directory)) throw new ConfigError("Location directory must be absolute", "invalid")
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(directory, name)
    if (await exists(candidate)) return { path: candidate, exists: true }
  }
  return { path: path.join(directory, DEFAULT_CONFIG_NAME), exists: false }
}

/** Real path of the file a write would replace (symlinks followed), plus the lexical path. */
async function canonicalTarget(directory: string): Promise<{ path: string; canonical: string; exists: boolean }> {
  const target = await resolveConfigPath(directory)
  try {
    if (target.exists) return { ...target, canonical: await fs.realpath(target.path) }
    return { ...target, canonical: path.join(await fs.realpath(directory), path.basename(target.path)) }
  } catch {
    throw new ConfigError(`Project directory ${directory} is not accessible`, "invalid")
  }
}

/** Parses JSONC strictly: any syntax error, or a non-object root, is a hard failure. */
export function parseConfig(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const first = errors[0]
    throw new ConfigError(
      `Refusing to modify malformed config ${file}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
      "malformed",
    )
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`Refusing to modify ${file}: root must be a JSON object`, "malformed")
  }
  return value as Record<string, unknown>
}

/** `providers` of the project config (empty when there is no config). */
export async function readProviders(directory: string): Promise<Record<string, unknown>> {
  const target = await resolveConfigPath(directory)
  if (!target.exists) return {}
  const config = parseConfig(await fs.readFile(target.path, "utf8"), target.path)
  const providers = config.providers
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return {}
  return providers as Record<string, unknown>
}

export async function readProviderIds(directory: string): Promise<string[]> {
  return Object.keys(await readProviders(directory))
}

class Conflict extends Error {}

/**
 * Atomic replace with conflict detection. The new content goes to a temp file in the
 * target's directory (mode, and owner where permitted, copied from the original). Just
 * before the rename, `precommit` re-checks lock ownership and target identity, and the
 * target is re-read: if anything changed since `expected` was read, nothing is replaced
 * and the caller retries from a fresh read. New files are created with link(2), which
 * fails rather than clobbering a file created concurrently. The temp file is removed on
 * every failure path.
 *
 * Guarantee: writers that take the plugin's lock are serialized. Writers that do not
 * (editors, OpenCode itself) are detected if they change the file, or retarget a config
 * symlink, before the final re-read; a change landing between that re-read and rename(2)
 * is lost. That residual window is accepted: POSIX offers no compare-and-swap rename.
 */
async function atomicWrite(
  file: string,
  text: string,
  expected: string | undefined,
  signal: AbortSignal | undefined,
  beforeReplace: (() => Promise<void>) | undefined,
  precommit: () => Promise<void>,
): Promise<void> {
  const stat = await fs.stat(file).catch(() => undefined)
  const mode = stat ? stat.mode & 0o777 : 0o644
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  let created = false
  try {
    const handle = await fs.open(temp, "wx", mode)
    created = true
    try {
      await handle.writeFile(text, "utf8")
      if (stat) await handle.chown(stat.uid, stat.gid).catch(() => undefined)
      await handle.chmod(mode).catch(() => undefined)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await beforeReplace?.()
    throwIfAborted(signal)
    await precommit()
    if (expected === undefined) {
      try {
        await fs.link(temp, file)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EEXIST") throw new Conflict()
        // Filesystems without hard links: best-effort exclusive create via rename.
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EOPNOTSUPP") throw error
        if (await fs.lstat(file).then(() => true, () => false)) throw new Conflict()
        await fs.rename(temp, file)
        created = false
      }
      return
    }
    const current = await fs.readFile(file, "utf8").catch(() => undefined)
    if (current !== expected) throw new Conflict()
    throwIfAborted(signal)
    await fs.rename(temp, file)
    created = false
  } finally {
    if (created) await fs.unlink(temp).catch(() => undefined)
  }
}

/**
 * Adds (or, with `overwrite`, updates) `providers.<id>` in the project config.
 * Comments, formatting, unknown keys and other providers are preserved. On
 * overwrite, only plugin-owned fields are rewritten; user fields such as
 * explicit `models`, `headers` or `env` stay intact. Never writes secrets.
 */
export async function persistProvider(
  directory: string,
  providerID: string,
  provider: PersistedProvider,
  options: {
    readonly overwrite?: boolean
    readonly signal?: AbortSignal
    /**
     * Expected current `providers.<id>` value (`undefined` = absent), compared inside the
     * locked transaction: if the entry differs, nothing is written (`changed`).
     */
    readonly expect?: { readonly entry: unknown }
    /** Test seam: runs after the new content is staged and before the target is checked and replaced. */
    readonly beforeReplace?: () => Promise<void>
    /** Test seam: how long to wait for a live lock owner (default 10 s). */
    readonly lockTimeout?: number
  } = {},
): Promise<PersistResult> {
  if (!path.isAbsolute(directory)) throw new ConfigError("Location directory must be absolute", "invalid")
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    throwIfAborted(options.signal)
    const target = await canonicalTarget(directory)
    const sameTarget = async () => {
      const again = await canonicalTarget(directory)
      return again.path === target.path && again.canonical === target.canonical && again.exists === target.exists
    }
    const outcome = await withLock(target.canonical, () =>
      withFileLock(target.canonical, options.signal, options.lockTimeout ?? LOCK_TIMEOUT, async (held) => {
        // The target may have changed while waiting (e.g. another writer created opencode.jsonc).
        if (!(await sameTarget())) return undefined
        const original = target.exists ? await fs.readFile(target.canonical, "utf8") : undefined
        const next = edit(original ?? "{}\n", target.path, providerID, provider, options.overwrite === true, options.expect)
        // Lock still ours and the lexical config still selects the same real file.
        const precommit = async () => {
          await held.verify()
          if (!(await sameTarget())) throw new Conflict()
        }
        try {
          await atomicWrite(target.canonical, next.text, original, options.signal, options.beforeReplace, precommit)
        } catch (error) {
          if (error instanceof Conflict) return undefined
          throw error
        }
        return { path: target.path, created: !target.exists, replaced: next.replaced }
      }),
    )
    if (outcome) return outcome
  }
  throw new ConfigError(`Config ${directory} kept changing while saving; nothing was overwritten. Try again.`, "conflict")
}

function edit(
  text: string,
  file: string,
  providerID: string,
  provider: PersistedProvider,
  overwrite: boolean,
  expect: { readonly entry: unknown } | undefined,
) {
  const config = parseConfig(text, file)
  const providers = config.providers
  if (providers !== undefined && (typeof providers !== "object" || providers === null || Array.isArray(providers))) {
    throw new ConfigError(`Refusing to modify ${file}: "providers" must be an object`, "malformed")
  }
  const existing = (providers as Record<string, unknown> | undefined)?.[providerID]
  if (existing !== undefined && !overwrite) {
    throw new ConfigError(`Provider '${providerID}' already exists in ${file}`, "duplicate")
  }
  if (expect && JSON.stringify(existing) !== JSON.stringify(expect.entry)) {
    throw new ConfigError(
      `Provider '${providerID}' was ${existing === undefined ? "removed from" : expect.entry === undefined ? "created in" : "changed in"} ${file} while it was being checked; nothing was written`,
      "changed",
    )
  }

  let next = text
  const apply = (jsonPath: (string | number)[], value: unknown) => {
    next = applyEdits(next, modify(next, jsonPath, value, FORMAT))
  }

  if (existing === undefined) {
    apply(["providers", providerID], {
      ...(provider.name ? { name: provider.name } : {}),
      package: provider.package,
      settings: { baseURL: provider.baseURL },
    })
  } else {
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      throw new ConfigError(`Refusing to modify ${file}: providers.${providerID} must be an object`, "malformed")
    }
    const current = existing as Record<string, unknown>
    if (provider.name) apply(["providers", providerID, "name"], provider.name)
    if (typeof current.package !== "string") apply(["providers", providerID, "package"], provider.package)
    const settings = current.settings
    if (settings !== undefined && (typeof settings !== "object" || settings === null || Array.isArray(settings))) {
      throw new ConfigError(`Refusing to modify ${file}: providers.${providerID}.settings must be an object`, "malformed")
    }
    apply(["providers", providerID, "settings", "baseURL"], provider.baseURL)
  }

  // Validate our own output before it can replace a working file.
  parseConfig(next, file)
  return { text: next.endsWith("\n") ? next : `${next}\n`, replaced: existing !== undefined }
}
