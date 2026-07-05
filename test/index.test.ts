import { describe, expect, test } from "bun:test"
import { createModelFallbackPlugin, getLastUserPayload, isRetryableError, normalizeOptions, parseModel } from "../src/plugin"

type PromptInput = {
  path: { id: string }
  query: { directory: string }
  body: {
    model: { providerID: string; modelID: string }
    parts: Array<{ type: string; text?: string }>
    agent?: string
    messageID?: string
  }
}

function createRuntime(messages: unknown = [
  {
    info: { role: "user", id: "msg_user" },
    parts: [{ type: "text", text: "do the thing" }],
  },
]) {
  const prompts: PromptInput[] = []
  const toasts: unknown[] = []
  const runtime = {
    directory: "/repo",
    client: {
      session: {
        messages: async () => messages,
        promptAsync: async (input: PromptInput) => {
          prompts.push(input)
        },
      },
      tui: {
        showToast: async (input: unknown) => {
          toasts.push(input)
        },
      },
    },
  }

  return { runtime, prompts, toasts }
}

async function emitSessionCreated(plugin: ReturnType<typeof createModelFallbackPlugin>) {
  await plugin.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "ses_1",
        info: { agent: "build" },
        model: { providerID: "anthropic", modelID: "claude-opus" },
      },
    },
  })
}

async function emitRateLimit(plugin: ReturnType<typeof createModelFallbackPlugin>) {
  await plugin.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        model: { providerID: "anthropic", modelID: "claude-opus" },
        error: { status: 429, message: "rate limit" },
      },
    },
  })
}

describe("model fallback plugin", () => {
  test("#given a retryable session error #when fallback is enabled #then it retries with the next model", async () => {
    // given
    const { runtime, prompts, toasts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)

    // when
    await emitRateLimit(plugin)

    // then
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts[0]?.body.parts).toEqual([{ type: "text", text: "do the thing" }])
    expect(prompts[0]?.body.agent).toBe("build")
    expect(prompts[0]?.body.messageID).toBe("msg_user")
    expect(toasts).toHaveLength(1)
  })

  test("#given a non-retryable session error #when it fires #then it does nothing", async () => {
    // given
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)

    // when
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          model: { providerID: "anthropic", modelID: "claude-opus" },
          error: { status: 401, message: "bad key" },
        },
      },
    })

    // then
    expect(prompts).toHaveLength(0)
  })

  test("#given no last user message #when retryable error fires #then it does not prompt", async () => {
    // given
    const { runtime, prompts } = createRuntime([])
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)

    // when
    await emitRateLimit(plugin)

    // then
    expect(prompts).toHaveLength(0)
  })

  test("#given fallback is disabled by config #when session enables it #then retry works", async () => {
    // given
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      enabled: false,
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)

    // when
    await emitRateLimit(plugin)
    await plugin.tool.model_fallback_control.execute({ action: "enable" }, {
      sessionID: "ses_1",
      messageID: "msg_tool",
      agent: "build",
      directory: "/repo",
      worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: async () => undefined,
    })
    await emitRateLimit(plugin)

    // then
    expect(prompts).toHaveLength(1)
  })

  test("#given fallback is enabled by config #when session disables it #then retry is skipped", async () => {
    // given
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)

    // when
    await plugin.tool.model_fallback_control.execute({ action: "disable" }, {
      sessionID: "ses_1",
      messageID: "msg_tool",
      agent: "build",
      directory: "/repo",
      worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: async () => undefined,
    })
    await emitRateLimit(plugin)

    // then
    expect(prompts).toHaveLength(0)
  })

  test("#given a fallback model was selected #when next chat message runs #then it applies the model override", async () => {
    // given
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)
    await emitRateLimit(plugin)
    const output = {
      message: {},
      parts: [],
    }

    // when
    await plugin["chat.message"]({
      sessionID: "ses_1",
    }, output)

    // then
    expect(output.message).toEqual({ model: { providerID: "openai", modelID: "gpt-5.1-codex" } })
  })

  test("#given a configured unavailable model #when first chat message runs #then it skips directly to fallback", async () => {
    // given
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      unavailable_models: ["anthropic/claude-opus"],
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    const output = {
      message: {},
      parts: [],
    }

    // when
    await plugin["chat.message"]({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus" },
    }, output)

    // then
    expect(output.message).toEqual({ model: { providerID: "openai", modelID: "gpt-5.1-codex" } })
  })

  test("#given a configured unavailable default model #when config hook runs #then it rewrites before provider use", async () => {
    // given
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      unavailable_models: ["anthropic/claude-opus"],
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    const config = {
      model: "anthropic/claude-opus",
      agent: {
        build: { model: "anthropic/claude-opus" },
        plan: { model: "openai/gpt-5.1-codex" },
      },
    }

    // when
    await plugin.config(config)

    // then
    expect(config).toEqual({
      model: "openai/gpt-5.1-codex",
      agent: {
        build: { model: "openai/gpt-5.1-codex" },
        plan: { model: "openai/gpt-5.1-codex" },
      },
    })
  })

  test("#given a session override #when reset runs #then config default is restored", async () => {
    // given
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      enabled: true,
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)

    // when
    await plugin.tool.model_fallback_control.execute({ action: "disable" }, {
      sessionID: "ses_1",
      messageID: "msg_tool",
      agent: "build",
      directory: "/repo",
      worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: async () => undefined,
    })
    const result = await plugin.tool.model_fallback_control.execute({ action: "reset" }, {
      sessionID: "ses_1",
      messageID: "msg_tool",
      agent: "build",
      directory: "/repo",
      worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: async () => undefined,
    })

    // then
    expect(JSON.parse(String(result))).toMatchObject({ enabled: true, override: null, attempts: 0 })
  })
})

describe("helpers", () => {
  test("#given model strings #when parsed #then provider and model are split once", () => {
    expect(parseModel("openai/gpt-5.1-codex")).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(parseModel("badmodel")).toBeUndefined()
  })

  test("#given options #when normalized #then invalid models are dropped", () => {
    expect(normalizeOptions({ fallback_models: ["bad", "openai/gpt-5", { model: "bad-shape" } as never] }).fallbackModels).toEqual(["openai/gpt-5"])
  })

  test("#given retryable errors #when classified #then status and text patterns match", () => {
    expect(isRetryableError({ status: 503 }, [503])).toBe(true)
    expect(isRetryableError("model is temporarily unavailable", [])).toBe(true)
    expect(isRetryableError({ status: 401 }, [503])).toBe(false)
  })

  test("#given messages response #when extracting payload #then last user message wins", () => {
    expect(getLastUserPayload({
      data: [
        { info: { role: "user", id: "first" }, parts: [{ type: "text", text: "first" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "answer" }] },
        { info: { role: "user", id: "second" }, parts: [{ type: "text", text: "second" }] },
      ],
    })).toEqual({
      messageID: "second",
      parts: [{ type: "text", text: "second" }],
    })
  })
})
