import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import fsSync from "node:fs"
import { persistProvider, readProviderIds, resolveConfigPath, ConfigError } from "../../packages/v2/dist/v2/persist.js"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { tempDir } from "./helpers.mjs"

const { parse: parseJsonc } = createRequire(import.meta.url)("../../packages/v2/node_modules/jsonc-parser")

const PKG = "@opencode/ai/providers/openai-compatible"
const entry = { package: PKG, baseURL: "http://127.0.0.1:9/v1" }

async function listFiles(directory) {
  return (await fs.readdir(directory)).sort()
}

test("creates opencode.jsonc in the location directory when no project config exists", async () => {
  const dir = await tempDir()
  const result = await persistProvider(dir, "proxy", { ...entry, name: "Proxy" })
  assert.equal(result.path, path.join(dir, "opencode.jsonc"))
  assert.equal(result.created, true)
  assert.deepEqual(await listFiles(dir), ["opencode.jsonc"])
  const written = JSON.parse(await fs.readFile(result.path, "utf8"))
  assert.deepEqual(written, { providers: { proxy: { name: "Proxy", package: PKG, settings: { baseURL: entry.baseURL } } } })
})

test("preserves comments, formatting, unknown keys and other providers", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  const original = `{
  // user comment kept
  "$schema": "https://opencode.ai/config.json",
  "customUnknownKey": { "nested": [1, 2, 3] }, /* block comment */
  "providers": {
    "existing": { "package": "@opencode/ai/providers/openai", "settings": { "timeout": 5 } }, // trailing
  },
}
`
  await fs.writeFile(file, original)
  await persistProvider(dir, "proxy", entry)
  const text = await fs.readFile(file, "utf8")
  assert.match(text, /\/\/ user comment kept/)
  assert.match(text, /\/\* block comment \*\//)
  assert.match(text, /\/\/ trailing/)
  // Untouched lines are byte-identical; lines the edit touches may be re-indented by the
  // JSONC formatter (the same modify/applyEdits mechanism OpenCode core uses).
  assert.match(text, /"customUnknownKey": \{ "nested": \[1, 2, 3\] \}, \/\* block comment \*\//)
  assert.ok(text.startsWith('{\n  // user comment kept\n  "$schema": "https://opencode.ai/config.json",\n'))
  const parsed = parseJsonc(text)
  assert.deepEqual(parsed.customUnknownKey, { nested: [1, 2, 3] })
  assert.deepEqual(parsed.providers.existing, { package: "@opencode/ai/providers/openai", settings: { timeout: 5 } })
  assert.deepEqual(parsed.providers.proxy, { package: PKG, settings: { baseURL: entry.baseURL } })
  assert.deepEqual((await readProviderIds(dir)).sort(), ["existing", "proxy"])
})

test("malformed config is rejected and left byte-for-byte unchanged", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.json")
  const broken = '{ "providers": { "a": { } , }\n  "oops" \n'
  await fs.writeFile(file, broken)
  await assert.rejects(persistProvider(dir, "proxy", entry), (error) => error instanceof ConfigError && error.code === "malformed")
  assert.equal(await fs.readFile(file, "utf8"), broken)
  await assert.rejects(readProviderIds(dir), ConfigError)

  await fs.writeFile(file, "[1, 2]")
  await assert.rejects(persistProvider(dir, "proxy", entry), /root must be a JSON object/)
  await fs.writeFile(file, '{ "providers": [] }')
  await assert.rejects(persistProvider(dir, "proxy", entry), /"providers" must be an object/)
  assert.equal(await fs.readFile(file, "utf8"), '{ "providers": [] }')
  assert.deepEqual(await listFiles(dir), ["opencode.json"], "no temp files left behind")
})

test("only the intended project file is modified; never config.json or .opencode/", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "config.json"), '{"provider":{}}')
  await fs.mkdir(path.join(dir, ".opencode"))
  await fs.writeFile(path.join(dir, ".opencode", "opencode.jsonc"), "{ /* nested */ }")
  await fs.writeFile(path.join(dir, "opencode.json"), '{\n  "model": "a/b"\n}\n')
  const result = await persistProvider(dir, "proxy", entry)
  assert.equal(result.path, path.join(dir, "opencode.json"))
  assert.equal(await fs.readFile(path.join(dir, "config.json"), "utf8"), '{"provider":{}}')
  assert.equal(await fs.readFile(path.join(dir, ".opencode", "opencode.jsonc"), "utf8"), "{ /* nested */ }")
  assert.equal(JSON.parse(await fs.readFile(result.path, "utf8")).model, "a/b")
})

test("prefers opencode.jsonc when both project files exist", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.json"), "{}")
  await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}")
  assert.equal((await resolveConfigPath(dir)).path, path.join(dir, "opencode.jsonc"))
  await persistProvider(dir, "proxy", entry)
  assert.equal(await fs.readFile(path.join(dir, "opencode.json"), "utf8"), "{}")
})

test("duplicates are rejected unless overwrite; overwrite keeps user-owned fields", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  await fs.writeFile(file, `{
  "providers": {
    "proxy": {
      // my explicit models
      "models": { "pinned": { "name": "Pinned" } },
      "headers": { "X-Team": "a" },
      "settings": { "baseURL": "http://old.invalid/v1", "timeout": 30 }
    }
  }
}
`)
  await assert.rejects(persistProvider(dir, "proxy", entry), (error) => error.code === "duplicate")
  const result = await persistProvider(dir, "proxy", entry, { overwrite: true })
  assert.equal(result.replaced, true)
  const text = await fs.readFile(file, "utf8")
  assert.match(text, /\/\/ my explicit models/)
  const parsed = parseJsonc(text)
  assert.deepEqual(parsed.providers.proxy.models, { pinned: { name: "Pinned" } })
  assert.deepEqual(parsed.providers.proxy.headers, { "X-Team": "a" })
  assert.deepEqual(parsed.providers.proxy.settings, { baseURL: entry.baseURL, timeout: 30 })
  assert.equal(parsed.providers.proxy.package, PKG)
})

test("concurrent writes are serialized and none are lost", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.json"), "{}\n")
  const ids = Array.from({ length: 12 }, (_, i) => `p${i}`)
  await Promise.all(ids.map((id) => persistProvider(dir, id, entry)))
  assert.deepEqual((await readProviderIds(dir)).sort(), [...ids].sort())
  assert.deepEqual(await listFiles(dir), ["opencode.json"])
})

test("never writes secrets and preserves file mode", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.json")
  await fs.writeFile(file, "{}\n", { mode: 0o600 })
  await fs.chmod(file, 0o600)
  await persistProvider(dir, "proxy", { ...entry, apiKey: "sk-test-should-not-appear" })
  const text = await fs.readFile(file, "utf8")
  assert.equal(text.includes("sk-test"), false)
  assert.equal(text.includes("apiKey"), false)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
})

test("writes through a symlinked config without replacing the link", async () => {
  const dir = await tempDir()
  const realDir = await tempDir()
  const real = path.join(realDir, "shared.jsonc")
  await fs.writeFile(real, "{ // shared\n}\n")
  await fs.symlink(real, path.join(dir, "opencode.jsonc"))
  await persistProvider(dir, "proxy", entry)
  assert.equal((await fs.lstat(path.join(dir, "opencode.jsonc"))).isSymbolicLink(), true)
  assert.match(await fs.readFile(real, "utf8"), /"proxy"/)
})

test("relative directories are rejected", async () => {
  await assert.rejects(persistProvider("relative/dir", "proxy", entry), (error) => error.code === "invalid")
})

// ── R6: canonical locking, inter-process coordination, conflict detection ──

const padded = (providers = {}) => JSON.stringify({ padding: "x".repeat(1_500_000), providers })

test("R6 review repro: concurrent writes through a symlinked directory alias are not lost", async () => {
  const dir = await tempDir()
  const alias = `${dir}-alias`
  await fs.symlink(dir, alias)
  await fs.writeFile(path.join(dir, "opencode.jsonc"), padded())
  await Promise.all([persistProvider(dir, "a", entry), persistProvider(alias, "b", entry)])
  assert.deepEqual((await readProviderIds(dir)).sort(), ["a", "b"])
  assert.deepEqual(await listFiles(dir), ["opencode.jsonc"], "no lock or temp files left")
})

test("R6: two project directories whose configs link to one file share the lock", async () => {
  const shared = await tempDir()
  const real = path.join(shared, "shared.jsonc")
  await fs.writeFile(real, padded())
  const one = await tempDir()
  const two = await tempDir()
  await fs.symlink(real, path.join(one, "opencode.jsonc"))
  await fs.symlink(real, path.join(two, "opencode.jsonc"))
  await Promise.all([persistProvider(one, "one", entry), persistProvider(two, "two", entry), persistProvider(one, "three", entry)])
  assert.deepEqual((await readProviderIds(shared === one ? one : two)).sort(), ["one", "three", "two"])
  assert.equal((await fs.lstat(path.join(one, "opencode.jsonc"))).isSymbolicLink(), true)
  assert.deepEqual(await listFiles(shared), ["shared.jsonc"])
})

test("R6 review repro: eight separate processes each add a provider; none is lost", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, "opencode.jsonc"), padded())
  const moduleURL = new URL("../../packages/v2/dist/v2/persist.js", import.meta.url).href
  const start = Date.now() + 1000
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new Promise((resolve, reject) => {
        const code = `import { persistProvider } from ${JSON.stringify(moduleURL)}
await new Promise((r) => setTimeout(r, Math.max(0, ${start} - Date.now())))
await persistProvider(${JSON.stringify(dir)}, "p${i}", ${JSON.stringify(entry)})`
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] })
        let errors = ""
        child.stderr.on("data", (chunk) => (errors += chunk))
        child.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(errors))))
      }),
    ),
  )
  assert.deepEqual((await readProviderIds(dir)).sort(), ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"])
  assert.deepEqual(await listFiles(dir), ["opencode.jsonc"])
})

test("R6: an external editor's change between read and replace is detected and merged, never overwritten", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  await fs.writeFile(file, '{\n  "providers": {}\n}\n')
  let edits = 0
  await persistProvider(dir, "ours", entry, {
    beforeReplace: async () => {
      if (edits++ === 0) await fs.writeFile(file, '{\n  // editor\n  "theme": "dark",\n  "providers": { "theirs": { "settings": { "baseURL": "http://127.0.0.1:2/v1" } } }\n}\n')
    },
  })
  const parsed = parseJsonc(await fs.readFile(file, "utf8"))
  assert.equal(edits, 2, "retried once after the conflict")
  assert.equal(parsed.theme, "dark")
  assert.deepEqual(Object.keys(parsed.providers).sort(), ["ours", "theirs"])
  assert.match(await fs.readFile(file, "utf8"), /\/\/ editor/)
})

test("R6: a file that keeps changing fails with a conflict and keeps the other writer's content; temp files are removed", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  await fs.writeFile(file, "{}\n")
  let n = 0
  await assert.rejects(
    persistProvider(dir, "ours", entry, { beforeReplace: () => fs.writeFile(file, `{ "rev": ${++n} }\n`) }),
    (error) => error instanceof ConfigError && error.code === "conflict",
  )
  assert.equal(await fs.readFile(file, "utf8"), `{ "rev": ${n} }\n`)
  assert.deepEqual(await listFiles(dir), ["opencode.jsonc"])
})

test("R6: a new config created by someone else concurrently is not clobbered", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  let once = true
  await persistProvider(dir, "ours", entry, {
    beforeReplace: async () => {
      if (once) {
        once = false
        await fs.writeFile(file, '{ "providers": { "theirs": {} } }\n')
      }
    },
  })
  assert.deepEqual((await readProviderIds(dir)).sort(), ["ours", "theirs"])
})

test("minor: temp files are cleaned up when staging or replacing fails", async () => {
  for (const initial of ["{}\n", undefined]) {
    const dir = await tempDir()
    if (initial) await fs.writeFile(path.join(dir, "opencode.json"), initial)
    await assert.rejects(
      persistProvider(dir, "ours", entry, { beforeReplace: async () => { throw new Error("injected failure") } }),
      /injected failure/,
    )
    assert.deepEqual(await listFiles(dir), initial ? ["opencode.json"] : [], "only the original file remains")
  }
})

test("R6: a stale lock from a dead process is broken; cancellation before replace writes nothing", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "opencode.jsonc")
  await fs.writeFile(file, "{}\n")
  // Owner record as this host writes it (host, PID namespace): only then can a dead PID be judged.
  const pidns = (() => { try { return fsSync.readlinkSync("/proc/self/ns/pid") } catch { return undefined } })()
  await fs.writeFile(path.join(dir, ".opencode.jsonc.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), ...(pidns ? { pidns } : {}), token: "dead", time: Date.now() }))
  await persistProvider(dir, "ours", entry)
  assert.deepEqual(await readProviderIds(dir), ["ours"])
  assert.deepEqual(await listFiles(dir), ["opencode.jsonc"])

  const controller = new AbortController()
  await assert.rejects(
    persistProvider(dir, "cancelled", entry, { signal: controller.signal, beforeReplace: async () => controller.abort() }),
    (error) => error.code === "cancelled",
  )
  assert.deepEqual(await readProviderIds(dir), ["ours"])
  assert.deepEqual(await listFiles(dir), ["opencode.jsonc"])
})
