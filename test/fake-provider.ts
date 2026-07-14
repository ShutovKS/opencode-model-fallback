export {}

const port = Number(Bun.env.FAKE_PORT || "0")
const logFile = Bun.env.FAKE_LOG || "/tmp/fake-provider-calls.json"

const calls: Array<{ path: string; model: string; status: number }> = []

async function flush() {
  await Bun.write(logFile, JSON.stringify(calls))
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const body = await req.json().catch(() => ({}))
    const model = (typeof body.model === "string" ? body.model : "unknown")

    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [
          { id: "fail-model", object: "model" },
          { id: "err-model", object: "model" },
          { id: "ok-model", object: "model" },
          { id: "ok-model-2", object: "model" },
          { id: "deny-model", object: "model" },
          { id: "retry-model", object: "model" },
          { id: "unavail-model", object: "model" },
          { id: "cascade-model", object: "model" },
        ],
      })
    }

    if (model === "ok-model" || model === "ok-model-2") {
      calls.push({ path: url.pathname, model, status: 200 })
      await flush()

      if (body.stream) {
        return new Response(
          `data: {"id":"x","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return Response.json({
        id: "x",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      })
    }

    const statusMap: Record<string, number> = {
      "fail-model": 429,
      "err-model": 503,
      "deny-model": 401,
      "retry-model": 400,
      "unavail-model": 400,
      // 400 (not auto-retried by OpenCode) so the plugin cascades promptly;
      // OpenCode self-retries 429/503 with its own backoff before emitting
      // session.error, which would mask plugin-driven cascade.
      "cascade-model": 400,
    }
    const status = statusMap[model] ?? 500
    calls.push({ path: url.pathname, model, status })
    await flush()

    return Response.json(
      { error: { message: `error from ${model}`, code: String(status) } },
      { status },
    )
  },
})

await flush()
console.error(`READY ${server.port}`)
await new Promise(() => {})