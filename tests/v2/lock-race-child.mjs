// Child process for the ordered cooperative lock race (pass3 M1). Real fs calls are only
// paused at named points; nothing is fabricated. Usage: node lock-race-child.mjs <role> <dir>
import fs from "node:fs/promises"
import path from "node:path"
import { syncBuiltinESMExports } from "node:module"

const [role, dir] = process.argv.slice(2)
const file = path.join(dir, "opencode.jsonc")
const lock = path.join(dir, ".opencode.jsonc.lock")
const entry = { package: "@opencode/ai/providers/openai-compatible", baseURL: "http://127.0.0.1:9/v1" }
const pause = (phase) => new Promise((resolve) => { process.once("message", resolve); process.send({ phase }) })

const read = fs.readFile
const rename = fs.rename
let lockReads = 0
let fileReads = 0
let breaking = false
const breakingPause = async () => {
  if (role !== "breaker" || breaking) return
  breaking = true
  await pause("breaking")
}
fs.readFile = async (...args) => {
  const result = await read(...args)
  if (role === "breaker" && args[0] === lock) {
    // First read: the dead owner's record. The next one is any re-check made while breaking.
    if (++lockReads === 1) await pause("dead-read")
    else await breakingPause()
  }
  if (role === "holder" && args[0] === file && ++fileReads === 2) await pause("final-read")
  return result
}
fs.rename = async (...args) => {
  const result = await rename(...args)
  if (args[0] === lock && lockReads >= 1) await breakingPause()
  return result
}
syncBuiltinESMExports()

try {
  const { persistProvider } = await import(new URL("../../packages/v2/dist/v2/persist.js", import.meta.url).href)
  await persistProvider(dir, role, entry)
  process.send({ phase: "done", ok: true })
} catch (error) {
  process.send({ phase: "done", ok: false, code: error.code, message: error.message })
}
process.disconnect()
