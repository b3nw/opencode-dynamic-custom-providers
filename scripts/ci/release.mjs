#!/usr/bin/env node
// CI/release helper for the two independent npm packages in this repository.
// Node stdlib only: it runs before (and independently of) any dependency install.
//
//   node scripts/ci/release.mjs select --tag <tag> [--ref <git-ref>]
//   node scripts/ci/release.mjs check-latest --track <v1|v2> --version <ver> [--registry <url>]
//   node scripts/ci/release.mjs pack --track <v1|v2> --out-dir <dir>
//   node scripts/ci/release.mjs verify-tarball --track <v1|v2> --tarball <file.tgz>
//   node scripts/ci/release.mjs verify-consumer --track <v1|v2> --tarball <file.tgz>
//
// Results are printed as key=value lines and, when GITHUB_OUTPUT is set, appended there.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const REPOSITORY_URL = "git+https://github.com/b3nw/opencode-dynamic-custom-providers.git"

// The only two publishable units. Anything not listed here can never be selected.
export const TRACKS = Object.freeze({
  v1: Object.freeze({
    track: "v1",
    tagPrefix: "v1-plugin-v",
    dir: ".",
    name: "opencode-dynamic-custom-providers",
    environment: "npm-release-v1",
    // Root package: flat dist/ only (never dist/v2 or any nested build output).
    files: [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^dist\/[A-Za-z0-9_-]+\.(js|d\.ts)$/],
    required: ["package.json", "README.md", "LICENSE"],
    // Exact production closure is owned by @opencode-ai/plugin; only dev-only names are banned.
    prodClosure: null,
  }),
  v2: Object.freeze({
    track: "v2",
    tagPrefix: "v2-plugin-v",
    dir: "packages/v2",
    name: "opencode-dynamic-custom-providers-v2",
    environment: "npm-release-v2",
    files: [
      /^package\.json$/,
      /^README\.md$/,
      /^LICENSE$/,
      /^CHANGELOG\.md$/,
      /^dist\/v2\/[A-Za-z0-9_-]+\.(js|d\.ts)$/,
    ],
    required: ["package.json", "README.md", "LICENSE", "CHANGELOG.md"],
    prodClosure: ["jsonc-parser"],
  }),
})

// Strict SemVer 2.0.0 without build metadata (npm drops "+build", so it would not round-trip).
const NUM = "(?:0|[1-9]\\d*)"
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)"
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`)

export function parseVersion(version) {
  const m = typeof version === "string" ? SEMVER.exec(version) : null
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ? m[4].split(".") : [] }
}

export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new Error(`cannot compare non-semver versions ${a} / ${b}`)
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  if (!x.prerelease.length || !y.prerelease.length) return Math.sign(y.prerelease.length - x.prerelease.length)
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i]
    const q = y.prerelease[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return +p < +q ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

export function readManifest(track, root = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, TRACKS[track].dir, "package.json"), "utf8"))
}

// Map a pushed tag to exactly one track and check it against that track's manifest.
// `manifests` is injectable for tests; by default the checked-out package.json files are read.
export function selectRelease(tag, { ref, manifests } = {}) {
  if (typeof tag !== "string" || tag === "") throw new Error("release tag is empty")
  if (ref !== undefined && ref !== `refs/tags/${tag}`) {
    throw new Error(`ref ${JSON.stringify(ref)} is not the tag ref refs/tags/${tag}`)
  }
  const matches = Object.values(TRACKS).filter((t) => tag.startsWith(t.tagPrefix))
  if (matches.length !== 1) {
    throw new Error(`tag ${JSON.stringify(tag)} must start with one of: ${Object.values(TRACKS).map((t) => t.tagPrefix).join(", ")}`)
  }
  const t = matches[0]
  const version = tag.slice(t.tagPrefix.length)
  const parsed = parseVersion(version)
  if (!parsed) throw new Error(`tag ${JSON.stringify(tag)}: ${JSON.stringify(version)} is not a strict semver version (no "v", no build metadata)`)
  const manifest = manifests ? manifests[t.track] : readManifest(t.track)
  if (!manifest) throw new Error(`no manifest for track ${t.track}`)
  if (manifest.name !== t.name) {
    throw new Error(`${t.dir}/package.json name ${JSON.stringify(manifest.name)} is not the ${t.track} package ${t.name}`)
  }
  if (manifest.version !== version) {
    throw new Error(`tag ${tag} selects ${t.name}@${version} but ${t.dir}/package.json has version ${manifest.version}`)
  }
  if (manifest.private) throw new Error(`${t.dir}/package.json is private`)
  if (manifest.repository?.url !== REPOSITORY_URL) {
    throw new Error(`${t.dir}/package.json repository.url must be ${REPOSITORY_URL} for npm provenance`)
  }
  const prerelease = parsed.prerelease.length > 0
  return {
    track: t.track,
    dir: t.dir,
    name: t.name,
    version,
    prerelease,
    dist_tag: prerelease ? "next" : "latest",
    environment: t.environment,
    tarball: `${t.name}-${version}.tgz`,
  }
}

// A stable release moves `latest`; refuse to move it backwards (e.g. a late 2.1.x patch after 2.2.0).
// `distTags` is the registry's dist-tags object for this package, or null when it is not published yet.
export function checkLatest(version, distTags) {
  const parsed = parseVersion(version)
  if (!parsed) throw new Error(`invalid version ${version}`)
  if (parsed.prerelease.length) return { ok: true, reason: "prerelease publishes to next" }
  const current = distTags?.latest
  if (!current) return { ok: true, reason: "no current latest" }
  if (current === version) throw new Error(`${version} is already latest; npm versions are immutable, bump the version`)
  if (compareVersions(version, current) < 0) {
    throw new Error(`${version} is lower than current latest ${current}; publishing it would move latest backwards`)
  }
  return { ok: true, reason: `${version} > latest ${current}` }
}

export async function fetchDistTags(name, registry = "https://registry.npmjs.org/") {
  // Anonymous, read-only registry GET. 404 means the name is not published yet.
  const url = new URL(`-/package/${encodeURIComponent(name)}/dist-tags`, registry.endsWith("/") ? registry : `${registry}/`)
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

// --- tarball inspection (ustar + pax/GNU long names, as written by npm pack) ---

function cstr(buf, start, len) {
  const s = buf.subarray(start, start + len)
  const nul = s.indexOf(0)
  return s.subarray(0, nul === -1 ? s.length : nul).toString("utf8")
}

function octal(buf, start, len) {
  const s = cstr(buf, start, len).trim()
  if (!/^[0-7]*$/.test(s)) throw new Error(`invalid tar numeric field ${JSON.stringify(s)}`)
  return s ? parseInt(s, 8) : 0
}

function paxPath(body) {
  let found
  let i = 0
  while (i < body.length) {
    const sp = body.indexOf(0x20, i)
    if (sp === -1) break
    const len = parseInt(body.subarray(i, sp).toString("utf8"), 10)
    if (!(len > 0)) throw new Error("malformed pax header")
    const rec = body.subarray(sp + 1, i + len - 1).toString("utf8")
    const eq = rec.indexOf("=")
    if (rec.slice(0, eq) === "path") found = rec.slice(eq + 1)
    i += len
  }
  return found
}

export function readTarGz(data) {
  const buf = gunzipSync(data)
  const entries = []
  let off = 0
  let longName
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const size = octal(h, 124, 12)
    const type = String.fromCharCode(h[156] || 0x30)
    const body = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === "x" || type === "L") {
      longName = type === "L" ? cstr(body, 0, body.length) : paxPath(body)
      continue
    }
    if (type === "g") continue
    const prefix = cstr(h, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100))
    longName = undefined
    entries.push({ path: name, type, size, data: type === "0" ? Buffer.from(body) : undefined })
  }
  return entries
}

// Validate the packed bytes: member allow-list, entry types, and the packed manifest's identity.
export function verifyTarball(track, data, manifest = readManifest(track)) {
  const t = TRACKS[track]
  if (!t) throw new Error(`unknown track ${track}`)
  const errors = []
  const files = new Map()
  for (const e of readTarGz(data)) {
    if (e.type === "5") continue
    if (e.type !== "0") {
      errors.push(`${e.path}: entry type ${JSON.stringify(e.type)} is not a regular file`)
      continue
    }
    if (!e.path.startsWith("package/")) {
      errors.push(`${e.path}: outside package/`)
      continue
    }
    const rel = e.path.slice("package/".length)
    if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
      errors.push(`${e.path}: unsafe path`)
      continue
    }
    if (files.has(rel)) errors.push(`${rel}: duplicate entry`)
    files.set(rel, e.data)
    if (!t.files.some((re) => re.test(rel))) errors.push(`${rel}: not allowed in the ${t.track} package`)
  }
  for (const req of t.required) if (!files.has(req)) errors.push(`${req}: missing`)
  let packed
  if (files.has("package.json")) {
    try {
      packed = JSON.parse(files.get("package.json").toString("utf8"))
    } catch {
      errors.push("package.json: not JSON")
    }
  }
  if (packed) {
    if (packed.name !== t.name) errors.push(`packed name ${packed.name} is not ${t.name}`)
    if (packed.name !== manifest.name || packed.version !== manifest.version) {
      errors.push(`packed ${packed.name}@${packed.version} does not match ${t.dir}/package.json ${manifest.name}@${manifest.version}`)
    }
    if (packed.repository?.url !== REPOSITORY_URL) errors.push(`packed repository.url is not ${REPOSITORY_URL}`)
    for (const s of ["preinstall", "install", "postinstall"]) {
      if (packed.scripts?.[s]) errors.push(`packed manifest has a consumer-side ${s} script`)
    }
    for (const target of exportTargets(packed)) {
      const rel = target.replace(/^\.\//, "")
      if (rel !== "package.json" && !files.has(rel)) errors.push(`export target ${target} is not in the tarball`)
    }
  }
  if (errors.length) throw new Error(`${t.name} tarball failed boundary checks:\n  - ${errors.join("\n  - ")}`)
  return { name: packed.name, version: packed.version, files: [...files.keys()].sort() }
}

function exportTargets(manifest) {
  const out = new Set()
  const walk = (v) => {
    if (typeof v === "string") out.add(v)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(manifest.exports)
  if (manifest.main) out.add(manifest.main)
  if (manifest.types) out.add(manifest.types)
  return [...out]
}

// Pack the already-built package exactly once. Lifecycle scripts are skipped so `prepare`/`prepack`
// cannot rebuild dist/ after the tests ran: the tarball holds the tested build output.
export function pack(track, outDir, root = REPO_ROOT) {
  const t = TRACKS[track]
  const dest = path.resolve(outDir)
  fs.mkdirSync(dest, { recursive: true })
  if (fs.readdirSync(dest).some((f) => f.endsWith(".tgz"))) throw new Error(`${dest} already holds a tarball; pack exactly once`)
  const out = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dest], {
    cwd: path.join(root, t.dir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  const info = JSON.parse(out)
  const manifest = readManifest(track, root)
  const expected = `${manifest.name}-${manifest.version}.tgz`
  if (info.length !== 1 || info[0].filename !== expected) throw new Error(`npm pack produced ${JSON.stringify(info.map((i) => i.filename))}, expected ${expected}`)
  return path.join(dest, expected)
}

// Install the tarball like a consumer would (production deps only, no lifecycle scripts) into a
// fresh directory, then import every public entry point from there.
export function verifyConsumer(track, tarball, { manifest = readManifest(track), keep = false } = {}) {
  const t = TRACKS[track]
  const abs = path.resolve(tarball)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `consumer-${t.track}-`))
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `consumer-${t.track}`, private: true, type: "module" }))
    execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", abs], {
      cwd: dir,
      stdio: ["ignore", "inherit", "inherit"],
    })
    const installed = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", t.name, "package.json"), "utf8"))
    if (installed.name !== manifest.name || installed.version !== manifest.version) {
      throw new Error(`installed ${installed.name}@${installed.version} does not match ${manifest.name}@${manifest.version}`)
    }
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"))
    const names = new Set()
    // A devDependency may legitimately be present when a production dependency requires it.
    const required = new Set(Object.keys(manifest.dependencies ?? {}))
    for (const [k, v] of Object.entries(lock.packages)) {
      if (!k.startsWith("node_modules/")) continue
      const n = k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length)
      if (n === t.name) continue
      names.add(n)
      for (const f of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const d of Object.keys(v[f] ?? {})) required.add(d)
      }
    }
    const leaked = Object.keys(manifest.devDependencies ?? {}).filter((d) => names.has(d) && !required.has(d))
    if (leaked.length) throw new Error(`dev-only dependencies installed in production closure: ${leaked.join(", ")}`)
    if (t.prodClosure) {
      const extra = [...names].filter((n) => !t.prodClosure.includes(n))
      if (extra.length) throw new Error(`unexpected production dependencies: ${extra.join(", ")}`)
    }
    const specs = Object.keys(installed.exports ?? { ".": installed.main })
      .filter((k) => k !== "./package.json")
      .map((k) => (k === "." ? t.name : `${t.name}/${k.slice(2)}`))
    const script = path.join(dir, "import-check.mjs")
    fs.writeFileSync(
      script,
      `const specs = ${JSON.stringify(specs)}\n` +
        `for (const s of specs) { const m = await import(s); if (!Object.keys(m).length) throw new Error(s + " has no exports"); console.log("import ok: " + s) }\n`,
    )
    execFileSync(process.execPath, [script], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] })
    return { dir: keep ? dir : undefined, imports: specs, closure: [...names].sort() }
  } finally {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex")
}

// --- CLI ---

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(k)}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${k}`)
    out[k.slice(2)] = v
    i++
  }
  return out
}

function emit(values) {
  const lines = Object.entries(values).map(([k, v]) => {
    const s = String(v)
    if (/[\r\n]/.test(s)) throw new Error(`refusing multi-line output ${k}`)
    return `${k}=${s}`
  })
  console.log(lines.join("\n"))
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n")
}

function trackArg(a) {
  if (!Object.hasOwn(TRACKS, a.track ?? "")) throw new Error("--track must be v1 or v2")
  return a.track
}

async function main([cmd, ...rest]) {
  const a = args(rest)
  switch (cmd) {
    case "select":
      emit(selectRelease(a.tag, { ref: a.ref }))
      return
    case "check-latest": {
      const track = trackArg(a)
      const tags = await fetchDistTags(TRACKS[track].name, a.registry)
      const r = checkLatest(a.version, tags)
      console.log(`latest check: ${r.reason}`)
      return
    }
    case "pack": {
      const track = trackArg(a)
      if (!a["out-dir"]) throw new Error("--out-dir is required")
      const file = pack(track, a["out-dir"])
      emit({ tarball: file, filename: path.basename(file), sha256: sha256(fs.readFileSync(file)) })
      return
    }
    case "verify-tarball": {
      const track = trackArg(a)
      const data = fs.readFileSync(a.tarball)
      const r = verifyTarball(track, data)
      console.log(r.files.map((f) => `  ${f}`).join("\n"))
      emit({ name: r.name, version: r.version, sha256: sha256(data), files: r.files.length })
      return
    }
    case "verify-consumer": {
      const track = trackArg(a)
      const r = verifyConsumer(track, a.tarball)
      console.log(`production closure: ${r.closure.join(", ") || "(none)"}`)
      return
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(cmd)}; use select | check-latest | pack | verify-tarball | verify-consumer`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    const msg = String(e.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
    console.error(`::error::${msg}`)
    process.exit(1)
  })
}
