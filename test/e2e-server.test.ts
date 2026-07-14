import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk"

const PLUGIN_PATH = new URL("../dist/index.js", import.meta.url).pathname
const FAKE_PROVIDER_SCRIPT = new URL("./fake-provider.ts", import.meta.url).pathname

type Call = { path: string; model: string; status: number }

type Env = {
  server: { url: string; close(): void }
  client: ReturnType<typeof createOpencodeClient>
  calls: () => Call[]
  waitForCall: (pred: (c: Call) => boolean, ms?: number) => Promise<boolean>
  stop: () => void
}

async function startFakeProvider(): Promise<{ port: number; proc: ReturnType<typeof Bun.spawn>; callLog: string }> {
  const callLog = join(tmpdir(), `mf-calls-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(callLog, "[]")
  const proc = Bun.spawn({
    cmd: ["bun", "run", FAKE_PROVIDER_SCRIPT],
    env: { ...process.env, FAKE_PORT: "0", FAKE_LOG: callLog },
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
      return { port: Number(match[1]), proc, callLog }
    }
  }
}

function makeConfig(port: number, pluginOpts: Record<string, unknown>): string {
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
          "cascade-model": { name: "Cascade" },
        },
      },
    },
    model: "fake/retry-model",
    permission: "allow",
    plugin: [[PLUGIN_PATH, pluginOpts]],
  })
}

async function withServer(pluginOpts: Record<string, unknown>, fn: (env: Env) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mf-e2e-"))
  const dataDir = mkdtempSync(join(tmpdir(), "mf-data-"))
  const fake = await startFakeProvider()
  const config = JSON.parse(makeConfig(fake.port, pluginOpts))

  const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
  const prevDataHome = process.env.XDG_DATA_HOME
  const prevConfigHome = process.env.XDG_CONFIG_HOME
  process.env.OPENCODE_CONFIG_DIR = ""
  process.env.XDG_DATA_HOME = dataDir
  process.env.XDG_CONFIG_HOME = dataDir

  let server: { url: string; close(): void } | undefined
  try {
    server = await createOpencodeServer({ config, port: 0, timeout: 15000 })
    const client = createOpencodeClient({ directory: dir, baseUrl: server.url })
    const calls = () => {
      try { return JSON.parse(readFileSync(fake.callLog, "utf-8")) as Call[] } catch { return [] }
    }
    const waitForCall = async (pred: (c: Call) => boolean, ms = 10000): Promise<boolean> => {
      const start = Date.now()
      while (Date.now() - start < ms) {
        if (calls().some(pred)) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return calls().some(pred)
    }
    await fn({
      server,
      client,
      calls,
      waitForCall,
      stop: () => {},
    })
  } finally {
    server?.close()
    fake.proc.kill()
    process.env.OPENCODE_CONFIG_DIR = prevConfigDir
    process.env.XDG_DATA_HOME = prevDataHome
    process.env.XDG_CONFIG_HOME = prevConfigHome
    rmSync(dir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(fake.callLog, { force: true })
  }
}

// OpenCode event stream wraps each event as { payload: { type, properties } }.
type Ev = { type: string; properties: any }

async function collectEvents(client: ReturnType<typeof createOpencodeClient>, _sessionID: string): Promise<{ stop: () => void; events: () => Ev[]; wait: (pred: (e: Ev) => boolean, ms?: number) => Promise<Ev | undefined>; attachSession: (sid: string) => void }> {
  const allEvents: Ev[] = []
  let filterSid: string | undefined
  const matches = (e: Ev) => !filterSid || e.properties?.sessionID === filterSid || !e.properties?.sessionID
  const sse = await client.global.event() as any
  const iterator = sse.stream[Symbol.asyncIterator]()
  let stopped = false
  const pump = (async () => {
    while (!stopped) {
      try {
        const { value, done } = await iterator.next()
        if (done) break
        const payload = value?.payload
        if (payload && payload.type) {
          allEvents.push({ type: payload.type, properties: payload.properties ?? {} })
        }
      } catch {
        break
      }
    }
  })()
  const events = () => allEvents.filter(matches)
  const wait = async (pred: (e: Ev) => boolean, ms = 8000): Promise<Ev | undefined> => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const found = events().find(pred)
      if (found) return found
      await new Promise((r) => setTimeout(r, 50))
    }
    return events().find(pred)
  }
  return {
    events,
    wait,
    attachSession: (sid: string) => { filterSid = sid },
    stop: () => { stopped = true; try { sse.stream?.return?.() } catch {} void pump },
  }
}

async function createSession(client: ReturnType<typeof createOpencodeClient>) {
  const res = await client.session.create({ body: { title: "t" } })
  const id = (res.data as any)?.id
  if (!id) throw new Error("no session id: " + JSON.stringify(res))
  return id as string
}

function modelRef(model: string) {
  const [providerID, ...parts] = model.split("/")
  return { providerID, modelID: parts.join("/") }
}

describe("e2e-server: model fallback plugin (in-process)", () => {
  // Default plugin options used across tests; per-test overrides applied.
  const baseOpts = (): Record<string, unknown> => ({
    enabled: true,
    notify: true,
  })

  test("status-path fallback: retry-model 400 -> ok-model, with switch toast", async () => {
    await withServer({
      ...baseOpts(),
      fallback_models: ["fake/ok-model"],
      retry_on_errors: [400],
    }, async ({ client, waitForCall }) => {
      const ev = await collectEvents(client, "")
      const sid = await createSession(client)
      ev.attachSession(sid)
      await client.session.promptAsync({ path: { id: sid }, body: { model: modelRef("fake/retry-model"), parts: [{ type: "text", text: "hello" }] } })

      const toast = await ev.wait((e) => e.type === "tui.toast.show" && e.properties?.message?.includes("Switched to"))
      expect(toast?.properties?.message).toContain("ok-model")

      // a fallback retry prompt went to ok-model
      const ok = await ev.wait((e) => e.type === "message.updated" && e.properties?.info?.role === "user" && e.properties?.info?.model?.modelID === "ok-model", 10000)
      expect(ok).toBeDefined()

      expect(await waitForCall((c) => c.model === "retry-model" && c.path.endsWith("/chat/completions"))).toBe(true)
      expect(await waitForCall((c) => c.model === "ok-model" && c.path.endsWith("/chat/completions"))).toBe(true)
      ev.stop()
    })
  }, 30000)

  test("retry_on_patterns: status-independent fallback via error text", async () => {
    await withServer({
      ...baseOpts(),
      fallback_models: ["fake/ok-model"],
      retry_on_errors: [],
      retry_on_patterns: ["error from retry-model"],
    }, async ({ client, waitForCall }) => {
      const ev = await collectEvents(client, "")
      const sid = await createSession(client)
      ev.attachSession(sid)
      await client.session.promptAsync({ path: { id: sid }, body: { model: modelRef("fake/retry-model"), parts: [{ type: "text", text: "hello" }] } })

      // status not configured as retryable; only the pattern triggers fallback
      const switched = await ev.wait((e) => e.type === "message.updated" && e.properties?.info?.role === "user" && e.properties?.info?.model?.modelID === "ok-model", 12000)
      expect(switched).toBeDefined()

      expect(await waitForCall((c) => c.model === "ok-model" && c.path.endsWith("/chat/completions"))).toBe(true)
      ev.stop()
    })
  }, 30000)

  test("cascade fallback: retry-model -> cascade-model -> ok-model-2", async () => {
    await withServer({
      ...baseOpts(),
      fallback_models: ["fake/cascade-model", "fake/ok-model-2"],
      retry_on_errors: [400, 429],
    }, async ({ client, waitForCall }) => {
      const ev = await collectEvents(client, "")
      const sid = await createSession(client)
      ev.attachSession(sid)
      await client.session.promptAsync({ path: { id: sid }, body: { model: modelRef("fake/retry-model"), parts: [{ type: "text", text: "hello" }] } })

      // first switch to cascade-model
      const first = await ev.wait((e) => e.type === "message.updated" && e.properties?.info?.role === "user" && e.properties?.info?.model?.modelID === "cascade-model", 12000)
      expect(first).toBeDefined()
      // then to ok-model-2
      const second = await ev.wait((e) => e.type === "message.updated" && e.properties?.info?.role === "user" && e.properties?.info?.model?.modelID === "ok-model-2", 12000)
      expect(second).toBeDefined()

      expect(await waitForCall((c) => c.model === "retry-model")).toBe(true)
      expect(await waitForCall((c) => c.model === "cascade-model")).toBe(true)
      expect(await waitForCall((c) => c.model === "ok-model-2")).toBe(true)
      ev.stop()
    })
  }, 40000)

  test("recovery: returns to the original model after cooldown expires", async () => {
    await withServer({
      ...baseOpts(),
      fallback_models: ["fake/ok-model"],
      retry_on_errors: [400],
      cooldown_ms: 1,
      recover_original_model: true,
    }, async ({ client }) => {
      const ev = await collectEvents(client, "")
      const sid = await createSession(client)
      ev.attachSession(sid)
      await client.session.promptAsync({ path: { id: sid }, body: { model: modelRef("fake/retry-model"), parts: [{ type: "text", text: "hello" }] } })

      // switched to ok-model
      const switched = await ev.wait((e) => e.type === "message.updated" && e.properties?.info?.role === "user" && e.properties?.info?.model?.modelID === "ok-model", 12000)
      expect(switched).toBeDefined()
      await ev.wait((e) => e.type === "session.status" && e.properties?.status?.type === "idle", 12000)
      await new Promise((r) => setTimeout(r, 10))

      // send a follow-up user message on the CURRENT (fallback) model, so the
      // plugin enters the recovery branch (requestedModel == currentModel, but
      // currentModel != originalModel) and restores the original once cooldown
      // has expired.
      await client.session.promptAsync({ path: { id: sid }, body: { model: modelRef("fake/ok-model"), parts: [{ type: "text", text: "again" }] } })
      const recovered = await ev.wait((e) => e.type === "message.updated" && e.properties?.info?.role === "user" && e.properties?.info?.model?.modelID === "retry-model", 12000)
      expect(recovered).toBeDefined()

      const toast = await ev.wait((e) => e.type === "tui.toast.show" && e.properties?.message?.includes("Recovered"), 8000)
      expect(toast).toBeDefined()
      expect(toast!.properties.message).toContain("retry-model")
      ev.stop()
    })
  }, 40000)
})
