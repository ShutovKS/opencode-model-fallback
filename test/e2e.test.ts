import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"

const PLUGIN_PATH = new URL("../dist/index.js", import.meta.url).pathname
const FAKE_PROVIDER_SCRIPT = new URL("./fake-provider.ts", import.meta.url).pathname
const CALL_LOG = "/tmp/e2e-calls.json"

type Call = { path: string; model: string; status: number }

function readCalls(): Call[] {
  try { return JSON.parse(readFileSync(CALL_LOG, "utf-8")) } catch { return [] }
}

async function startFakeProvider(): Promise<{ port: number; proc: ReturnType<typeof Bun.spawn> }> {
  writeFileSync(CALL_LOG, "[]")
  const proc = Bun.spawn({
    cmd: ["bun", "run", FAKE_PROVIDER_SCRIPT],
    env: { ...process.env, FAKE_PORT: "0", FAKE_LOG: CALL_LOG },
    stdout: "pipe",
    stderr: "pipe",
  })

  const stderr = proc.stderr
  if (!stderr || typeof stderr === "number") throw new Error("no stderr")
  const reader = (stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error("fake provider exited before ready: " + buf)
    buf += decoder.decode(value, { stream: true })
    const match = buf.match(/READY (\d+)/)
    if (match) {
      reader.releaseLock()
      return { port: Number(match[1]), proc }
    }
  }
}

function makeConfig(port: number, pluginOpts: Record<string, unknown>, extraConfig: Record<string, unknown> = {}) {
  return JSON.stringify({
    provider: {
      fake: {
        api: "openai",
        name: "Fake",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test-key" },
        models: {
          "fail-model": { name: "Fail" },
          "err-model": { name: "Error" },
          "ok-model": { name: "OK" },
          "ok-model-2": { name: "OK2" },
          "deny-model": { name: "Deny" },
          "retry-model": { name: "Retry" },
          "unavail-model": { name: "Unavail" },
        },
      },
    },
    model: "fake/ok-model",
    permission: "allow",
    plugin: [[PLUGIN_PATH, pluginOpts]],
    ...extraConfig,
  })
}

async function runOpenCode(
  port: number,
  model: string,
  prompt: string,
  pluginOpts: Record<string, unknown>,
  extraConfig: Record<string, unknown> = {},
  timeoutMs = 25000,
  agent?: string,
): Promise<{ code: number | null }> {
  const config = makeConfig(port, pluginOpts, extraConfig)

  const cmd = ["opencode", "run", "--format", "json"]
  if (agent) cmd.push("--agent", agent)
  cmd.push("--model", model, prompt)

  const proc = Bun.spawn({
    cmd,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: config,
      OPENCODE_CONFIG_DIR: "",
      PATH: process.env.PATH || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))
  const result = await Promise.race([proc.exited, timeout])

  if (result === null) {
    proc.kill()
    return { code: null }
  }

  return { code: result }
}

async function continueSession(
  port: number,
  pluginOpts: Record<string, unknown>,
  extraConfig: Record<string, unknown> = {},
  timeoutMs = 25000,
): Promise<{ code: number | null }> {
  const config = makeConfig(port, pluginOpts, extraConfig)

  const proc = Bun.spawn({
    cmd: ["opencode", "run", "--format", "json", "--continue", "x"],
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: config,
      OPENCODE_CONFIG_DIR: "",
      PATH: process.env.PATH || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))
  const result = await Promise.race([proc.exited, timeout])

  if (result === null) {
    proc.kill()
    return { code: null }
  }

  return { code: result }
}

let fakePort = 0
let fakeProc: ReturnType<typeof Bun.spawn> | null = null

beforeEach(async () => {
  const { port, proc } = await startFakeProvider()
  fakePort = port
  fakeProc = proc
}, 10000)

afterEach(() => {
  if (fakeProc) {
    fakeProc.kill()
    fakeProc = null
  }
})

describe("e2e: model fallback plugin", () => {
  test("unavailable model: fail-model is unavailable, rewrite to ok-model", async () => {
    const { code } = await runOpenCode(fakePort, "fake/fail-model", "reply ok", {
      enabled: true,
      unavailable_models: ["fake/fail-model"],
      fallback_models: ["fake/ok-model"],
      notify: false,
    })

    expect(code).toBe(0)
    const chatCalls = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    expect(chatCalls.length).toBeGreaterThan(0)
    for (const c of chatCalls) {
      expect(c.model).not.toBe("fail-model")
    }
    expect(chatCalls.some(c => c.model === "ok-model")).toBe(true)
  }, 35000)

  test("config hook: unavailable model rewritten in config", async () => {
    const { code } = await runOpenCode(fakePort, "fake/unavail-model", "reply ok", {
      enabled: true,
      unavailable_models: ["fake/unavail-model"],
      fallback_models: ["fake/ok-model"],
      notify: false,
    })

    expect(code).toBe(0)
    const chatCalls = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    expect(chatCalls.length).toBeGreaterThan(0)
    for (const c of chatCalls) {
      expect(c.model).not.toBe("unavail-model")
    }
  }, 35000)

  test("disabled plugin: fail-model returns 429, no fallback, fail-model IS called", async () => {
    await runOpenCode(fakePort, "fake/fail-model", "reply ok", {
      enabled: false,
      fallback_models: ["fake/ok-model"],
      notify: false,
    }, {}, 40000)

    const chatCalls = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    expect(chatCalls.some(c => c.model === "fail-model")).toBe(true)
    expect(chatCalls.some(c => c.model === "ok-model")).toBe(false)
  }, 50000)

  test("non-retryable error: deny-model returns 401, no fallback", async () => {
    await runOpenCode(fakePort, "fake/deny-model", "reply ok", {
      enabled: true,
      fallback_models: ["fake/ok-model"],
      notify: false,
    })

    const chatCalls = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    expect(chatCalls.some(c => c.model === "deny-model")).toBe(true)
    expect(chatCalls.some(c => c.model === "ok-model")).toBe(false)
  }, 35000)

  test("multi-model unavailable: both fail-model and err-model unavailable, ok-model used", async () => {
    const { code } = await runOpenCode(fakePort, "fake/fail-model", "reply ok", {
      enabled: true,
      unavailable_models: ["fake/fail-model", "fake/err-model"],
      fallback_models: ["fake/ok-model", "fake/ok-model-2"],
      notify: false,
    })

    expect(code).toBe(0)
    const chatCalls = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    for (const c of chatCalls) {
      expect(c.model).not.toBe("fail-model")
      expect(c.model).not.toBe("err-model")
    }
  }, 35000)

  test("retry-after-error: retry-model fails with 400, fallback to ok-model via --continue", async () => {
    // Step 1: send prompt with retry-model, which returns 400
    await runOpenCode(fakePort, "fake/retry-model", "hello", {
      enabled: true,
      fallback_models: ["fake/ok-model"],
      retry_on_errors: [400],
      notify: false,
    })

    // retry-model should have been called and returned 400
    const callsAfterFail = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    expect(callsAfterFail.some(c => c.model === "retry-model")).toBe(true)

    // Step 2: continue the session — processes the pending retry with ok-model
    await continueSession(fakePort, {
      enabled: true,
      fallback_models: ["fake/ok-model"],
      retry_on_errors: [400],
      notify: false,
    })

    // ok-model should now appear in the calls (from the retry)
    const callsAfterContinue = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    expect(callsAfterContinue.some(c => c.model === "ok-model")).toBe(true)
  }, 45000)

  test("agent config: unavailable model in agent config is rewritten", async () => {
    const { code } = await runOpenCode(fakePort, "fake/ok-model", "reply ok", {
      enabled: true,
      unavailable_models: ["fake/fail-model"],
      fallback_models: ["fake/ok-model"],
      notify: false,
    }, {
      agent: { build: { model: "fake/fail-model" } },
    }, 25000, "build")

    const chatCalls = readCalls().filter(c => c.path.endsWith("/chat/completions"))
    for (const c of chatCalls) {
      expect(c.model).not.toBe("fail-model")
    }
  }, 35000)
})