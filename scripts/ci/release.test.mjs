// Tests for scripts/ci/release.mjs (node --test scripts/ci/). No network, no npm, no repo mutation.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import {
  REPOSITORY_URL,
  TRACKS,
  checkLatest,
  compareVersions,
  parseVersion,
  readManifest,
  readTarGz,
  selectRelease,
  verifyTarball,
} from "./release.mjs"

const HELPER = fileURLToPath(new URL("./release.mjs", import.meta.url))

const manifest = (track, version, extra = {}) => ({
  name: TRACKS[track].name,
  version,
  repository: { type: "git", url: REPOSITORY_URL },
  ...extra,
})
const manifests = (v1 = "2.2.0", v2 = "0.1.0") => ({ v1: manifest("v1", v1), v2: manifest("v2", v2) })

// Minimal ustar writer: [path, content | {type, content}] -> .tgz bytes.
function tgz(entries) {
  const blocks = []
  for (const [name, spec] of entries) {
    const { type = "0", content = "" } = typeof spec === "object" && !Buffer.isBuffer(spec) ? spec : { content: spec }
    const body = Buffer.from(content)
    const h = Buffer.alloc(512)
    const put = (s, off, len) => Buffer.from(s).copy(h, off, 0, len)
    if (Buffer.byteLength(name) > 100) {
      const pax = (() => {
        const rec = ` path=${name}\n`
        let len = rec.length
        while (`${len}${rec}`.length !== len) len = `${len}${rec}`.length
        return Buffer.from(`${len}${rec}`)
      })()
      blocks.push(...tgzHeader("PaxHeader", "x", pax), pad(pax))
      put(name.slice(0, 99), 0, 100)
    } else put(name, 0, 100)
    fill(h, type, body.length)
    blocks.push(h, pad(body))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}
function tgzHeader(name, type, body) {
  const h = Buffer.alloc(512)
  Buffer.from(name).copy(h, 0)
  fill(h, type, body.length)
  return [h]
}
function fill(h, type, size) {
  Buffer.from("0000644\0").copy(h, 100)
  Buffer.from("0000000\0").copy(h, 108)
  Buffer.from("0000000\0").copy(h, 116)
  Buffer.from(size.toString(8).padStart(11, "0") + "\0").copy(h, 124)
  Buffer.from("00000000000\0").copy(h, 136)
  h[156] = type.charCodeAt(0)
  Buffer.from("ustar\0" + "00").copy(h, 257)
  h.fill(0x20, 148, 156)
  let sum = 0
  for (const b of h) sum += b
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ").copy(h, 148)
}
function pad(body) {
  return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

const v1Pkg = (over = {}) =>
  JSON.stringify({
    ...manifest("v1", "2.2.0"),
    main: "./dist/server.js",
    types: "./dist/server.d.ts",
    exports: {
      ".": { types: "./dist/server.d.ts", default: "./dist/server.js" },
      "./tui": { types: "./dist/tui.d.ts", default: "./dist/tui.js" },
    },
    scripts: { build: "tsc", prepare: "npm run build" },
    ...over,
  })
const v1Files = (pkg = v1Pkg()) => [
  ["package/package.json", pkg],
  ["package/README.md", "# r"],
  ["package/LICENSE", "MIT"],
  ["package/dist/server.js", "export default {}"],
  ["package/dist/server.d.ts", "export {}"],
  ["package/dist/tui.js", "export default {}"],
  ["package/dist/tui.d.ts", "export {}"],
]
const v2Pkg = (over = {}) =>
  JSON.stringify({
    ...manifest("v2", "0.1.0"),
    main: "./dist/v2/server.js",
    exports: { ".": "./dist/v2/server.js", "./rpc": "./dist/v2/rpc.js", "./package.json": "./package.json" },
    ...over,
  })
const v2Files = (pkg = v2Pkg()) => [
  ["package/package.json", pkg],
  ["package/README.md", "# r"],
  ["package/LICENSE", "MIT"],
  ["package/CHANGELOG.md", "# c"],
  ["package/dist/v2/server.js", "export default {}"],
  ["package/dist/v2/rpc.js", "export const x = 1"],
  ["package/dist/v2/rpc.d.ts", "export {}"],
]

test("parseVersion accepts strict semver only", () => {
  for (const ok of ["0.1.0", "2.2.0", "10.20.30", "1.0.0-beta.1", "1.0.0-rc.0", "1.0.0-x-y.7a", "1.0.0-0"]) {
    assert.ok(parseVersion(ok), ok)
  }
  for (const bad of ["v1.0.0", "1.0", "1.0.0.0", "01.0.0", "1.02.0", "1.0.0-01", "1.0.0-", "1.0.0+build", "1.0.0-a..b", " 1.0.0", "1.0.0\n", "1.0.0-beta_1", ""]) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad))
  }
})

test("compareVersions follows semver precedence", () => {
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0", "2.2.0", "10.0.0"]
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`)
    assert.equal(compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`)
  }
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0)
})

test("selectRelease maps each tag prefix to exactly its own package", () => {
  const v1 = selectRelease("v1-plugin-v2.2.0", { ref: "refs/tags/v1-plugin-v2.2.0", manifests: manifests() })
  assert.deepEqual(v1, {
    track: "v1",
    dir: ".",
    name: "opencode-dynamic-custom-providers",
    version: "2.2.0",
    prerelease: false,
    dist_tag: "latest",
    environment: "npm-release-v1",
    tarball: "opencode-dynamic-custom-providers-2.2.0.tgz",
  })
  const v2 = selectRelease("v2-plugin-v0.1.0", { manifests: manifests() })
  assert.equal(v2.track, "v2")
  assert.equal(v2.dir, "packages/v2")
  assert.equal(v2.name, "opencode-dynamic-custom-providers-v2")
  assert.equal(v2.environment, "npm-release-v2")
  assert.equal(v2.dist_tag, "latest")
})

test("prerelease tags publish to next, never latest", () => {
  const r = selectRelease("v2-plugin-v0.2.0-beta.1", { manifests: manifests("2.2.0", "0.2.0-beta.1") })
  assert.equal(r.prerelease, true)
  assert.equal(r.dist_tag, "next")
  const r1 = selectRelease("v1-plugin-v3.0.0-rc.1", { manifests: manifests("3.0.0-rc.1") })
  assert.equal(r1.dist_tag, "next")
})

test("tag/manifest version mismatch is rejected for the selected track", () => {
  // V2 tag carrying the V1 version, and vice versa: must not fall through to the other package.
  assert.throws(() => selectRelease("v2-plugin-v2.2.0", { manifests: manifests() }), /packages\/v2\/package.json has version 0.1.0/)
  assert.throws(() => selectRelease("v1-plugin-v0.1.0", { manifests: manifests() }), /\.\/package.json has version 2.2.0/)
  assert.throws(() => selectRelease("v1-plugin-v2.2.1", { manifests: manifests() }), /has version 2.2.0/)
  // Stable tag for a prerelease manifest (and the reverse) is a mismatch, not a coercion.
  assert.throws(() => selectRelease("v2-plugin-v0.2.0", { manifests: manifests("2.2.0", "0.2.0-beta.1") }), /has version/)
  assert.throws(() => selectRelease("v2-plugin-v0.1.0-rc.1", { manifests: manifests() }), /has version/)
})

test("invalid and foreign tags are rejected before any manifest is trusted", () => {
  const bad = [
    "",
    "v2.2.0",
    "v1.0.0",
    "v1-plugin-2.2.0",
    "v1-plugin-v",
    "v1-plugin-vv2.2.0",
    "v1-plugin-v2.2",
    "v1-plugin-v2.2.0+build.1",
    "v1-plugin-v02.2.0",
    "v3-plugin-v1.0.0",
    "V1-plugin-v2.2.0",
    "v2-plugin-v0.1.0 ",
    "v2-plugin-v0.1.0/x",
    "refs/tags/v2-plugin-v0.1.0",
    "x-v2-plugin-v0.1.0",
  ]
  for (const tag of bad) assert.throws(() => selectRelease(tag, { manifests: manifests() }), Error, JSON.stringify(tag))
  assert.throws(() => selectRelease(undefined, { manifests: manifests() }), /empty/)
})

test("ref must be exactly the tag ref (no branch publishing)", () => {
  const m = { manifests: manifests() }
  assert.throws(() => selectRelease("v1-plugin-v2.2.0", { ...m, ref: "refs/heads/v1-plugin-v2.2.0" }), /not the tag ref/)
  assert.throws(() => selectRelease("v1-plugin-v2.2.0", { ...m, ref: "refs/heads/main" }), /not the tag ref/)
  assert.throws(() => selectRelease("v1-plugin-v2.2.0", { ...m, ref: "refs/pull/1/merge" }), /not the tag ref/)
  assert.throws(() => selectRelease("v1-plugin-v2.2.0", { ...m, ref: "refs/tags/v2-plugin-v0.1.0" }), /not the tag ref/)
})

test("manifest identity: wrong name, private, or non-canonical repository fails", () => {
  const swapped = { v1: manifest("v2", "2.2.0"), v2: manifest("v2", "0.1.0") }
  assert.throws(() => selectRelease("v1-plugin-v2.2.0", { manifests: swapped }), /is not the v1 package/)
  const priv = { ...manifests(), v2: manifest("v2", "0.1.0", { private: true }) }
  assert.throws(() => selectRelease("v2-plugin-v0.1.0", { manifests: priv }), /private/)
  const ssh = { ...manifests(), v1: manifest("v1", "2.2.0", { repository: { type: "git", url: "git+ssh://git@github.com/b3nw/opencode-dynamic-custom-providers.git" } }) }
  assert.throws(() => selectRelease("v1-plugin-v2.2.0", { manifests: ssh }), /repository.url/)
})

test("checked-in manifests are selectable by their own tags only", () => {
  const v1 = readManifest("v1")
  const v2 = readManifest("v2")
  assert.equal(selectRelease(`v1-plugin-v${v1.version}`).name, TRACKS.v1.name)
  assert.equal(selectRelease(`v2-plugin-v${v2.version}`).name, TRACKS.v2.name)
  if (v1.version !== v2.version) {
    assert.throws(() => selectRelease(`v2-plugin-v${v1.version}`))
    assert.throws(() => selectRelease(`v1-plugin-v${v2.version}`))
  }
})

test("checkLatest guards the latest line", () => {
  assert.equal(checkLatest("0.1.0", null).ok, true)
  assert.equal(checkLatest("2.2.0", { latest: "2.0.0" }).ok, true)
  assert.throws(() => checkLatest("2.0.0", { latest: "2.0.0" }), /immutable/)
  assert.throws(() => checkLatest("2.1.9", { latest: "2.2.0" }), /backwards/)
  assert.equal(checkLatest("2.1.9-rc.1", { latest: "2.2.0" }).ok, true)
})

test("tar reader handles pax long names and directories", () => {
  const long = `package/dist/${"a".repeat(120)}.js`
  const entries = readTarGz(tgz([["package/", { type: "5" }], [long, "x"]]))
  assert.deepEqual(entries.map((e) => [e.path, e.type]), [["package/", "5"], [long, "0"]])
})

test("verifyTarball accepts minimal valid V1 and V2 packages", () => {
  const r1 = verifyTarball("v1", tgz(v1Files()), manifest("v1", "2.2.0"))
  assert.equal(r1.files.length, 7)
  const r2 = verifyTarball("v2", tgz(v2Files()), manifest("v2", "0.1.0"))
  assert.deepEqual([r2.name, r2.version], ["opencode-dynamic-custom-providers-v2", "0.1.0"])
})

test("verifyTarball: V1 must not contain V2 dist, sources, tests or scripts", () => {
  const m = manifest("v1", "2.2.0")
  for (const extra of ["package/dist/v2/server.js", "package/src/server.ts", "package/tests/server.test.mjs", "package/scripts/ci/release.mjs", "package/dist/server.js.map", "package/.npmrc", "package/node_modules/x/index.js", "package/CHANGELOG.md"]) {
    assert.throws(() => verifyTarball("v1", tgz([...v1Files(), [extra, "x"]]), m), /not allowed in the v1 package/, extra)
  }
})

test("verifyTarball: V2 contains only V2 dist", () => {
  const m = manifest("v2", "0.1.0")
  for (const extra of ["package/dist/server.js", "package/dist/v2/nested/x.js", "package/src/v2/server.ts", "package/tests/v2/server.test.mjs", "package/tsconfig.json", "package/scratch/x"]) {
    assert.throws(() => verifyTarball("v2", tgz([...v2Files(), [extra, "x"]]), m), /not allowed in the v2 package/, extra)
  }
})

test("verifyTarball: identity, exports and entry-type checks", () => {
  const m1 = manifest("v1", "2.2.0")
  // Packed version differs from the selected manifest (e.g. stale or rebuilt tarball).
  assert.throws(() => verifyTarball("v1", tgz(v1Files(v1Pkg({ version: "2.1.0" }))), m1), /does not match/)
  // Other package's tarball handed to this track.
  assert.throws(() => verifyTarball("v1", tgz(v2Files()), m1), /not allowed|is not opencode-dynamic-custom-providers/)
  assert.throws(() => verifyTarball("v2", tgz(v1Files()), manifest("v2", "0.1.0")), /not allowed/)
  // Missing export target.
  const noTui = v1Files().filter(([p]) => p !== "package/dist/tui.js")
  assert.throws(() => verifyTarball("v1", tgz(noTui), m1), /export target \.\/dist\/tui\.js/)
  // Consumer-side lifecycle script.
  assert.throws(() => verifyTarball("v1", tgz(v1Files(v1Pkg({ scripts: { postinstall: "x" } }))), m1), /postinstall/)
  // Non-canonical repository URL breaks provenance.
  assert.throws(() => verifyTarball("v1", tgz(v1Files(v1Pkg({ repository: "github:b3nw/x" }))), m1), /repository.url/)
  // Symlinks, traversal, missing LICENSE.
  assert.throws(() => verifyTarball("v1", tgz([...v1Files(), ["package/dist/link.js", { type: "2" }]]), m1), /not a regular file/)
  assert.throws(() => verifyTarball("v1", tgz([...v1Files(), ["package/../evil.js", "x"]]), m1), /unsafe path/)
  assert.throws(() => verifyTarball("v1", tgz([...v1Files(), ["other/x.js", "x"]]), m1), /outside package/)
  assert.throws(() => verifyTarball("v1", tgz(v1Files().filter(([p]) => p !== "package/LICENSE")), m1), /LICENSE: missing/)
})

test("CLI select writes GITHUB_OUTPUT and fails closed with an annotation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-cli-"))
  try {
    const out = path.join(dir, "out")
    const v2 = readManifest("v2")
    const tag = `v2-plugin-v${v2.version}`
    execFileSync(process.execPath, [HELPER, "select", "--tag", tag, "--ref", `refs/tags/${tag}`], {
      env: { ...process.env, GITHUB_OUTPUT: out },
      stdio: "pipe",
    })
    const lines = fs.readFileSync(out, "utf8").trim().split("\n")
    assert.ok(lines.includes("track=v2"))
    assert.ok(lines.includes(`name=${TRACKS.v2.name}`))
    assert.ok(lines.includes(`version=${v2.version}`))
    fs.writeFileSync(out, "")
    const r = (() => {
      try {
        execFileSync(process.execPath, [HELPER, "select", "--tag", "v2-plugin-v9.9.9"], { env: { ...process.env, GITHUB_OUTPUT: out }, stdio: "pipe" })
        return null
      } catch (e) {
        return e
      }
    })()
    assert.ok(r, "mismatched tag must exit non-zero")
    assert.equal(r.status, 1)
    assert.match(String(r.stderr), /^::error::tag v2-plugin-v9\.9\.9 selects/)
    assert.equal(fs.readFileSync(out, "utf8"), "", "no outputs on failure")
    assert.throws(() => execFileSync(process.execPath, [HELPER, "verify-tarball", "--track", "v3", "--tarball", "x"], { stdio: "pipe" }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- publish-v1 / publish-v2 "Publish the verified tarball" step, run from the real workflow YAML ---
// The privileged jobs never run this file; it executes their `run:` script locally against a fake
// registry, with `npm` shimmed so that `npm publish` is only recorded and any other npm use fails.

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url))

function publishStep(job) {
  const lines = fs.readFileSync(WORKFLOW, "utf8").split("\n")
  const start = lines.indexOf(`  ${job}:`)
  assert.ok(start > 0, `job ${job} not found`)
  let end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l))
  if (end < 0) end = lines.length
  const body = lines.slice(start, end)
  const name = /^ {6}EXPECTED_NAME: (\S+)$/m.exec(body.join("\n"))?.[1]
  const step = body.findIndex((l) => l.trim() === "- name: Publish the verified tarball")
  const run = body.findIndex((l, i) => i > step && l.trim() === "run: |")
  assert.ok(name && step > 0 && run > step, `publish step of ${job} not found`)
  const indent = body[run].search(/\S/)
  const script = []
  for (const l of body.slice(run + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break
    script.push(l)
  }
  const strip = script.find((l) => l.trim()).search(/\S/)
  return { name, script: script.map((l) => l.slice(strip)).join("\n").trimEnd() + "\n" }
}

// Bodies the public registry actually returns for an unpublished name (checked 2026-10-10).
const PACKAGE_404 = [404, '{"error":"Not found"}']
const DIST_TAGS_404 = [404, '"Not Found"']
const fixtureTarball = (name, version) => tgz([["package/package.json", JSON.stringify({ name, version })]])
const sha512 = (data) => `sha512-${createHash("sha512").update(data).digest("base64")}`

function fakeRegistry(routes) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    const route = routes[decodeURIComponent(req.url)] ?? PACKAGE_404
    res.writeHead(route[0], { "content-type": "application/json" })
    res.end(typeof route[1] === "string" ? route[1] : JSON.stringify(route[1]))
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/` })))
}

async function runPublishStep(job, { version, distTag = version.includes("-") ? "next" : "latest", registry, packument, distTags }) {
  const { name, script } = publishStep(job)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-publish-"))
  const fake = registry ? null : await fakeRegistry({ [`/${name}`]: packument, [`/-/package/${name}/dist-tags`]: distTags })
  try {
    const tarball = `${name}-${version}.tgz`
    const data = fixtureTarball(name, version)
    fs.writeFileSync(path.join(dir, tarball), data)
    fs.mkdirSync(path.join(dir, "bin"))
    fs.writeFileSync(path.join(dir, "step.sh"), script)
    fs.writeFileSync(
      path.join(dir, "bin", "npm"),
      `#!/bin/sh\n[ "$1" = publish ] || { echo "unexpected npm $*" >&2; exit 99; }\necho "$*" >> "${path.join(dir, "publish.log")}"\n`,
      { mode: 0o755 },
    )
    const env = {
      PATH: `${path.join(dir, "bin")}:${path.dirname(process.execPath)}:${process.env.PATH}`,
      EXPECTED_NAME: name,
      VERSION: version,
      DIST_TAG: distTag,
      TARBALL: tarball,
      SHA256: createHash("sha256").update(data).digest("hex"),
      NPM_REGISTRY: registry ?? fake.url,
    }
    // GitHub's default `run:` shell on Linux is `bash -e {0}`.
    const child = spawn("bash", ["-e", path.join(dir, "step.sh")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    const status = await new Promise((resolve) => child.on("close", resolve))
    const log = path.join(dir, "publish.log")
    const publishes = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
    return { status, out, publishes, tarball, registry: env.NPM_REGISTRY, seen: fake?.seen ?? [] }
  } finally {
    fake?.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const packumentOf = (versions, latest) => [200, { versions, "dist-tags": latest ? { latest } : {} }]

test("publish step: both jobs run the same registry guard, with no expressions in the script", () => {
  const v1 = publishStep("publish-v1")
  const v2 = publishStep("publish-v2")
  assert.equal(v1.name, TRACKS.v1.name)
  assert.equal(v2.name, TRACKS.v2.name)
  assert.equal(v1.script, v2.script)
  assert.doesNotMatch(v1.script, /\$\{\{/)
  assert.match(v1.script, /npm publish "\.\/\$\{TARBALL\}" --access public --tag "\$\{DIST_TAG\}"/)
})

for (const job of ["publish-v1", "publish-v2"]) {
  const newer = { "2.3.0": { dist: { integrity: "sha512-newer" } } }

  test(`${job}: "Re-run failed jobs" of 2.2.0 after 2.3.0 shipped publishes nothing and fails`, async () => {
    const r = await runPublishStep(job, { version: "2.2.0", packument: packumentOf(newer, "2.3.0"), distTags: [200, { latest: "2.3.0" }] })
    assert.notEqual(r.status, 0)
    assert.deepEqual(r.publishes, [])
    assert.match(r.out, /::error::.*current latest is 2\.3\.0/)
  })

  test(`${job}: a fresh dist-tags read wins over a stale cached packument`, async () => {
    const stale = await runPublishStep(job, { version: "2.2.0", packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, { latest: "2.3.0" }] })
    assert.notEqual(stale.status, 0)
    assert.deepEqual(stale.publishes, [])
    const equal = await runPublishStep(job, { version: "2.2.0", packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, { latest: "2.2.0" }] })
    assert.notEqual(equal.status, 0, "latest == version but packument lacks it: fail, never republish")
    assert.deepEqual(equal.publishes, [])
    assert.match(equal.out, /::error::.*current latest is 2\.2\.0/)
  })

  test(`${job}: stable release above latest publishes once with --tag latest`, async () => {
    const r = await runPublishStep(job, { version: "2.2.0", packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, { latest: "2.1.0", next: "2.2.0-rc.1" }] })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(r.publishes, [`publish ./${r.tarball} --access public --tag latest --registry ${r.registry} --provenance --ignore-scripts`])
    assert.deepEqual(r.seen, [`/${publishStep(job).name}`, `/-/package/${publishStep(job).name}/dist-tags`])
    const overRc = await runPublishStep(job, { version: "2.2.0", packument: packumentOf({ "2.1.0": {} }, "2.2.0-rc.1"), distTags: [200, { latest: "2.2.0-rc.1" }] })
    assert.equal(overRc.status, 0, overRc.out)
    assert.equal(overRc.publishes.length, 1)
  })

  test(`${job}: idempotent retry of identical bytes is a no-op even after a newer release`, async () => {
    const integrity = sha512(fixtureTarball(publishStep(job).name, "2.2.0"))
    const r = await runPublishStep(job, { version: "2.2.0", packument: packumentOf({ ...newer, "2.2.0": { dist: { integrity } } }, "2.3.0"), distTags: [200, { latest: "2.3.0" }] })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(r.publishes, [])
    assert.match(r.out, /::notice::.*already published with this exact tarball/)
  })

  test(`${job}: same version with different bytes fails (immutable)`, async () => {
    const r = await runPublishStep(job, { version: "2.2.0", packument: packumentOf({ "2.2.0": { dist: { integrity: "sha512-other" } } }, "2.2.0"), distTags: [200, { latest: "2.2.0" }] })
    assert.notEqual(r.status, 0)
    assert.deepEqual(r.publishes, [])
    assert.match(r.out, /immutable/)
  })

  test(`${job}: prerelease publishes to next and never touches latest`, async () => {
    const r = await runPublishStep(job, { version: "2.4.0-rc.1", packument: packumentOf(newer, "2.3.0"), distTags: [200, { latest: "2.3.0" }] })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.publishes.length, 1)
    assert.match(r.publishes[0], /--tag next /)
    const wrongTag = await runPublishStep(job, { version: "2.4.0-rc.1", distTag: "latest", packument: packumentOf(newer, "2.3.0"), distTags: [200, { latest: "2.3.0" }] })
    assert.notEqual(wrongTag.status, 0)
    assert.deepEqual(wrongTag.publishes, [])
  })

  test(`${job}: unpublished package (genuine 404 on both reads) bootstraps with --tag latest`, async () => {
    const r = await runPublishStep(job, { version: "0.1.0", packument: PACKAGE_404, distTags: DIST_TAGS_404 })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.publishes.length, 1)
    assert.match(r.publishes[0], /--tag latest /)
  })

  test(`${job}: registry outages and inconsistent or malformed responses fail closed`, async () => {
    const cases = {
      "packument 503": { packument: [503, { error: "unavailable" }], distTags: [200, { latest: "2.1.0" }] },
      "dist-tags 500": { packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [500, { error: "boom" }] },
      "dist-tags 403": { packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [403, { error: "forbidden" }] },
      "404 that is not package-not-found": { packument: [404, "<html>proxy</html>"], distTags: DIST_TAGS_404 },
      "packument missing, dist-tags present": { packument: PACKAGE_404, distTags: [200, { latest: "2.3.0" }] },
      "packument present, dist-tags missing": { packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: DIST_TAGS_404 },
      "non-JSON packument": { packument: [200, "not json"], distTags: [200, { latest: "2.1.0" }] },
      "non-JSON dist-tags": { packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, "{"] },
      "array dist-tags": { packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, ["2.1.0"]] },
      "malformed latest": { packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, { latest: "banana" }] },
      "null latest": { packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, { latest: null }] },
      "no latest on an existing package": { packument: packumentOf({ "2.1.0": {} }), distTags: [200, {}] },
      "malformed versions": { packument: [200, { versions: [], "dist-tags": { latest: "2.1.0" } }], distTags: [200, { latest: "2.1.0" }] },
      "existing version without integrity": { packument: packumentOf({ "2.2.0": { dist: {} } }, "2.1.0"), distTags: [200, { latest: "2.1.0" }] },
    }
    for (const [label, routes] of Object.entries(cases)) {
      const r = await runPublishStep(job, { version: "2.2.0", ...routes })
      assert.notEqual(r.status, 0, `${label}: ${r.out}`)
      assert.deepEqual(r.publishes, [], label)
      assert.match(r.out, /::error::/, label)
    }
    const down = await runPublishStep(job, { version: "2.2.0", registry: "http://127.0.0.1:9/" })
    assert.notEqual(down.status, 0)
    assert.deepEqual(down.publishes, [])
  })

  test(`${job}: a latest that is not a strict SemVer string fails closed`, async () => {
    const older = { "2.1.0": {} }
    const latests = ["2.2.0-01", "2.2.0-..", ["2.1.0"], "2.1.0-a..b", "2.1.0-", "2.1.0+", "2.1.0+a..b", "02.1.0", "v2.1.0", " 2.1.0", "2.1.0\n", 2.1, { v: "2.1.0" }, `2.1.0-${"a".repeat(251)}`]
    const wrong = []
    for (const latest of latests) {
      for (const [where, routes] of [
        ["dist-tags", { packument: packumentOf(older, "2.1.0"), distTags: [200, { latest }] }],
        ["packument", { packument: [200, { versions: older, "dist-tags": { latest } }], distTags: [200, { latest: "2.1.0" }] }],
      ]) {
        const label = `${where} latest ${JSON.stringify(latest)}`
        const r = await runPublishStep(job, { version: "2.2.0", ...routes })
        if (r.status === 0 || r.publishes.length || !/::error::.*malformed registry version/.test(r.out)) wrong.push(label)
      }
    }
    assert.deepEqual(wrong, [], "these malformed latests did not fail closed")
  })

  test(`${job}: valid prerelease and build-metadata latests compare by SemVer precedence`, async () => {
    const big = "9007199254740993"
    const cases = [
      ["2.2.0", "2.1.0+build.5", true],
      ["2.2.0", "2.2.0-rc.1+build.7", true],
      ["2.2.0", "2.2.0-0", true],
      ["2.2.0", "2.2.0-alpha-1.0a.x-y", true],
      ["2.2.0", "2.2.0+build", false],
      ["2.2.0", "2.2.1-rc.1", false],
      ["2.2.0", `${big}.0.0`, false],
      ["2.2.0", `${"9".repeat(200)}.0.0`, false],
      [`${big}.0.0`, "9007199254740992.0.0", true],
      ["9007199254740992.0.0", `${big}.0.0`, false],
      [`2.${big}.0`, "2.9007199254740992.0", true],
      [`2.2.${big}`, "2.2.9007199254740992", true],
    ]
    const wrong = []
    for (const [version, latest, ok] of cases) {
      const r = await runPublishStep(job, { version, packument: packumentOf({ "2.1.0": {} }, latest), distTags: [200, { latest }] })
      const right = ok ? r.status === 0 && r.publishes.length === 1 : r.status !== 0 && !r.publishes.length && /::error::.*would not move latest forward/.test(r.out)
      if (!right) wrong.push(`${version} over latest ${latest} should ${ok ? "publish" : "fail"}`)
    }
    assert.deepEqual(wrong, [])
  })

  test(`${job}: a successful packument without a non-empty versions object fails closed`, async () => {
    const cases = {
      missing: { "dist-tags": { latest: "2.1.0" } },
      null: { versions: null, "dist-tags": { latest: "2.1.0" } },
      array: { versions: [{ "2.1.0": {} }], "dist-tags": { latest: "2.1.0" } },
      string: { versions: "2.1.0", "dist-tags": { latest: "2.1.0" } },
      empty: { versions: {}, "dist-tags": { latest: "2.1.0" } },
    }
    const wrong = []
    for (const [label, body] of Object.entries(cases)) {
      const r = await runPublishStep(job, { version: "2.2.0", packument: [200, body], distTags: [200, { latest: "2.1.0" }] })
      if (r.status === 0 || r.publishes.length || !/::error::.*malformed packument versions/.test(r.out)) wrong.push(label)
    }
    assert.deepEqual(wrong, [], "these versions inventories did not fail closed")
  })

  test(`${job}: tarball digest, name and dist-tag checks still run before any registry read`, async () => {
    const r = await runPublishStep(job, { version: "2.2.0", distTag: "next", packument: packumentOf({ "2.1.0": {} }, "2.1.0"), distTags: [200, { latest: "2.1.0" }] })
    assert.notEqual(r.status, 0)
    assert.deepEqual(r.publishes, [])
    assert.deepEqual(r.seen, [])
  })
}
