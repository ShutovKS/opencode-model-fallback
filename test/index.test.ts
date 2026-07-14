import { describe, expect, test } from "bun:test"
import { computeBackoff, createModelFallbackPlugin, getLastUserPayload, isRetryableError, normalizeOptions, parseModel } from "../src/plugin"

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

async function emitSessionError(
  plugin: ReturnType<typeof createModelFallbackPlugin>,
  model: { providerID: string; modelID: string },
  status = 429,
) {
  await plugin.event({
    event: {
      type: "session.error",
      properties: { sessionID: "ses_1", model, error: { status } },
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

  test("#given first fallback is also unavailable #when first chat message runs #then it skips to the next fallback", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      unavailable_models: ["anthropic/claude-opus", "openai/gpt-5.1-codex"],
      fallback_models: ["openai/gpt-5.1-codex", "google/gemini-2.5-pro"],
    })
    const output = {
      message: {},
      parts: [],
    }

    await plugin["chat.message"]({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus" },
    }, output)

    expect(output.message).toEqual({ model: { providerID: "google", modelID: "gemini-2.5-pro" } })
  })

  test("#given session state was created before model is known #when unavailable chat model arrives #then it skips to fallback", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      unavailable_models: ["anthropic/claude-opus"],
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    const output = {
      message: {},
      parts: [],
    }

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_1", info: { agent: "build" } },
      },
    })
    await plugin["chat.message"]({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus" },
    }, output)

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

  test("#given first fallback is also unavailable #when config hook runs #then it skips to the next fallback", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      unavailable_models: ["anthropic/claude-opus", "openai/gpt-5.1-codex"],
      fallback_models: ["openai/gpt-5.1-codex", "google/gemini-2.5-pro"],
    })
    const config = {
      model: "anthropic/claude-opus",
      agent: {
        build: { model: "anthropic/claude-opus" },
        plan: { model: "openai/gpt-5.1-codex" },
      },
    }

    await plugin.config(config)

    expect(config).toEqual({
      model: "google/gemini-2.5-pro",
      agent: {
        build: { model: "google/gemini-2.5-pro" },
        plan: { model: "google/gemini-2.5-pro" },
      },
    })
  })

  test("#given config is disabled #when config hook runs #then models are left unchanged", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      enabled: false,
      unavailable_models: ["anthropic/claude-opus"],
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    const config = {
      model: "anthropic/claude-opus",
      agent: { build: { model: "anthropic/claude-opus" } },
    }

    await plugin.config(config)

    expect(config).toEqual({
      model: "anthropic/claude-opus",
      agent: { build: { model: "anthropic/claude-opus" } },
    })
  })

  test("#given no fallback models configured #when retryable error fires #then it does nothing", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {})
    await emitSessionCreated(plugin)
    await emitRateLimit(plugin)
    expect(prompts).toHaveLength(0)
  })

  test("#given a session.error without sessionID #when it fires #then it does nothing", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await plugin.event({
      event: {
        type: "session.error",
        properties: { error: { status: 429 } },
      },
    })
    expect(prompts).toHaveLength(0)
  })

  test("#given fallback is disabled at session level #when chat.message runs #then it does not override", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)
    await plugin.tool.model_fallback_control.execute({ action: "disable" }, {
      sessionID: "ses_1", messageID: "msg_tool", agent: "build",
      directory: "/repo", worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined, ask: async () => undefined,
    })
    const output = { message: {}, parts: [] }
    await plugin["chat.message"]({ sessionID: "ses_1" }, output)
    expect(output.message).toEqual({})
  })

  test("#given current model equals original #when chat.message runs #then it does not override", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)
    const output = { message: {}, parts: [] }
    await plugin["chat.message"]({
      sessionID: "ses_1",
      model: { providerID: "anthropic", modelID: "claude-opus" },
    }, output)
    expect(output.message).toEqual({})
  })

  test("#given model_fallback_control #when status is requested #then it returns current state", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)
    const result = await plugin.tool.model_fallback_control.execute({ action: "status" }, {
      sessionID: "ses_1", messageID: "msg_tool", agent: "build",
      directory: "/repo", worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined, ask: async () => undefined,
    })
    const parsed = JSON.parse(String(result))
    expect(parsed).toMatchObject({ enabled: true, attempts: 0 })
  })

  test("#given model_fallback_control #when unknown action is used #then it returns an error message", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {})
    const result = await plugin.tool.model_fallback_control.execute({ action: "unknown" }, {
      sessionID: "ses_1", messageID: "msg_tool", agent: "build",
      directory: "/repo", worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined, ask: async () => undefined,
    })
    expect(String(result)).toContain("Unknown action")
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

  test("#given several fallback models #when errors keep firing #then it cycles then stops on cooldown", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex", "anthropic/claude-sonnet"],
      max_attempts: 5,
    })
    await emitSessionCreated(plugin)

    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-opus" })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })

    await emitSessionError(plugin, { providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })

    // both fallbacks now cooling; no further model available
    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-sonnet" })
    expect(prompts).toHaveLength(2)
  })

  test("#given a model cooldown has expired #when a later error fires #then the model is reusable and stale cooldowns are pruned", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex", "anthropic/claude-sonnet"],
      max_attempts: 10,
      cooldown_ms: 1,
    })
    await emitSessionCreated(plugin)

    // opus fails -> switch to codex
    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-opus" })
    expect(prompts[0]?.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })

    // codex fails -> switch to sonnet
    await emitSessionError(plugin, { providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts[1]?.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })

    // wait for the 1ms cooldowns to expire so codex is selectable again
    await new Promise((resolve) => setTimeout(resolve, 5))

    // sonnet fails -> codex cooldown expired, so it is reused
    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-sonnet" })
    expect(prompts).toHaveLength(3)
    expect(prompts[2]?.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })
  })

  test("#given first fallback is also unavailable #when retrying a failed model #then it skips to the next fallback", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      unavailable_models: ["openai/gpt-5.1-codex"],
      fallback_models: ["openai/gpt-5.1-codex", "google/gemini-2.5-pro"],
    })
    await emitSessionCreated(plugin)

    await emitRateLimit(plugin)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body.model).toEqual({ providerID: "google", modelID: "gemini-2.5-pro" })
  })

  test("#given max_attempts reached #when another error fires #then it stops retrying", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex", "anthropic/claude-sonnet"],
      max_attempts: 2,
    })
    await emitSessionCreated(plugin)

    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-opus" })
    await emitSessionError(plugin, { providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts).toHaveLength(2)

    // attempts now 2 == max, cap kicks in before nextModel
    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-sonnet" })
    expect(prompts).toHaveLength(2)
  })

  test("#given max_attempts reached within the window #when the window elapses #then fallback is allowed again", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex", "anthropic/claude-sonnet"],
      max_attempts: 1,
      attempts_window_ms: 2,
    })
    await emitSessionCreated(plugin)

    // opus fails -> switch to codex (1 attempt in window)
    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-opus" })
    expect(prompts).toHaveLength(1)

    // codex fails within the window -> cap reached, blocked
    await emitSessionError(plugin, { providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts).toHaveLength(1)

    // window elapses; the earlier attempt no longer counts
    await new Promise((resolve) => setTimeout(resolve, 5))
    await emitSessionError(plugin, { providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
  })

  test("#given attempts_window_ms is 0 #when the cap is reached #then it stays an absolute lifetime limit", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex", "anthropic/claude-sonnet"],
      max_attempts: 1,
      attempts_window_ms: 0,
    })
    await emitSessionCreated(plugin)

    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-opus" })
    expect(prompts).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await emitSessionError(plugin, { providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts).toHaveLength(1)
  })

  test("#given a retry already in flight #when a second error fires #then it is ignored", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)

    const error = {
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          model: { providerID: "anthropic", modelID: "claude-opus" },
          error: { status: 429, message: "rate limit" },
        },
      },
    }
    await Promise.all([plugin.event(error), plugin.event(error)])
    expect(prompts).toHaveLength(1)
  })

  test("#given a retried session #when it is deleted then errors again #then state is rebuilt from scratch", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      max_attempts: 1,
    })
    await emitSessionCreated(plugin)

    await emitRateLimit(plugin)
    expect(prompts).toHaveLength(1)

    // max_attempts reached; without cleanup a second error would be ignored
    await plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_1" } } })
    await emitRateLimit(plugin)
    expect(prompts).toHaveLength(2)
  })

  test("#given a fallback was selected #when a stale error from the prior model arrives #then it is ignored", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })
    await emitSessionCreated(plugin)
    await emitRateLimit(plugin)
    expect(prompts).toHaveLength(1)

    // stale error reporting the old model, not the one we just switched to
    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-opus" })
    expect(prompts).toHaveLength(1)
  })

  test("#given the user switches models mid-session #when the next error fires #then attempts are reset", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      max_attempts: 1,
    })
    await emitSessionCreated(plugin)

    await emitRateLimit(plugin)
    // cap reached for claude-opus; a follow-up error on the fallback is also capped
    await emitSessionError(plugin, { providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(prompts).toHaveLength(1)

    // user manually switches to a new model via chat.message
    await plugin["chat.message"](
      { sessionID: "ses_1", model: { providerID: "anthropic", modelID: "claude-sonnet" } },
      { message: {}, parts: [] },
    )

    // error on the new model should retry from scratch
    await emitSessionError(plugin, { providerID: "anthropic", modelID: "claude-sonnet" })
    expect(prompts).toHaveLength(2)
  })

  test("#given a custom retry pattern #when a matching provider error fires #then it retries", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      retry_on_patterns: ["capacity constraints"],
    })
    await emitSessionCreated(plugin)

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          model: { providerID: "anthropic", modelID: "claude-opus" },
          error: { message: "hit capacity constraints, retry" },
        },
      },
    })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })
  })

  test("#given a fallback is active and original still cooling #when chat.message runs #then it stays on the fallback", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      cooldown_ms: 60_000,
    })
    await emitSessionCreated(plugin)
    await emitRateLimit(plugin)

    const output = { message: {}, parts: [] }
    await plugin["chat.message"]({ sessionID: "ses_1" }, output)

    expect(output.message).toEqual({ model: { providerID: "openai", modelID: "gpt-5.1-codex" } })
  })

  test("#given a fallback is active and original cooldown expired #when chat.message runs #then it recovers to the original model", async () => {
    const { runtime, toasts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      cooldown_ms: 1,
    })
    await emitSessionCreated(plugin)
    await emitRateLimit(plugin)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const output = { message: {}, parts: [] }
    await plugin["chat.message"]({ sessionID: "ses_1" }, output)

    expect(output.message).toEqual({ model: { providerID: "anthropic", modelID: "claude-opus" } })
    // switch toast + recovery toast
    expect(toasts).toHaveLength(2)

    // status should reflect we are back on the original with attempts reset
    const status = await plugin.tool.model_fallback_control.execute({ action: "status" }, {
      sessionID: "ses_1", messageID: "msg_tool", agent: "build",
      directory: "/repo", worktree: "/repo",
      abort: new AbortController().signal,
      metadata: () => undefined, ask: async () => undefined,
    })
    expect(JSON.parse(String(status))).toMatchObject({
      currentModel: "anthropic/claude-opus",
      originalModel: "anthropic/claude-opus",
      attempts: 0,
    })
  })

  test("#given recover_original_model is disabled #when original cooldown expires #then it stays on the fallback", async () => {
    const { runtime } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      cooldown_ms: 1,
      recover_original_model: false,
    })
    await emitSessionCreated(plugin)
    await emitRateLimit(plugin)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const output = { message: {}, parts: [] }
    await plugin["chat.message"]({ sessionID: "ses_1" }, output)

    expect(output.message).toEqual({ model: { providerID: "openai", modelID: "gpt-5.1-codex" } })
  })

  test("#given a backoff is configured #when a retry fires #then it delays before re-prompting but still retries", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      backoff_ms: 12,
    })
    await emitSessionCreated(plugin)

    const start = Date.now()
    await emitRateLimit(plugin)
    const elapsed = Date.now() - start

    expect(prompts).toHaveLength(1)
    // equal jitter -> at least half of backoff_ms elapsed before the prompt
    expect(elapsed).toBeGreaterThanOrEqual(5)
  })

  test("#given notify is disabled #when a retry fires #then no toast is shown", async () => {
    const { runtime, prompts, toasts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
      notify: false,
    })
    await emitSessionCreated(plugin)
    await emitRateLimit(plugin)
    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(0)
  })

  test("#given real OpenCode APIError shape #when retryable status fires #then it retries", async () => {
    const { runtime, prompts } = createRuntime()
    const plugin = createModelFallbackPlugin(runtime, {
      fallback_models: ["openai/gpt-5.1-codex"],
    })

    await plugin.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_1",
          info: {
            id: "ses_1",
            agent: "build",
            model: { providerID: "anthropic", id: "claude-opus" },
          },
        },
      },
    })
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: {
            name: "APIError",
            data: { statusCode: 429, isRetryable: true, message: "too busy" },
          },
        },
      },
    })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })
  })
})

describe("helpers", () => {
  test("#given model strings #when parsed #then provider and model are split once", () => {
    expect(parseModel("openai/gpt-5.1-codex")).toEqual({ providerID: "openai", modelID: "gpt-5.1-codex" })
    expect(parseModel("badmodel")).toBeUndefined()
  })

  test("#given a model id with slashes #when parsed #then only the first slash splits provider", () => {
    expect(parseModel("openai/gpt-5.1-codex/mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.1-codex/mini",
    })
  })

  test("#given options #when normalized #then invalid models are dropped", () => {
    expect(normalizeOptions({ fallback_models: ["bad", "openai/gpt-5", { model: "bad-shape" } as never] }).fallbackModels).toEqual(["openai/gpt-5"])
  })

  test("#given retryable errors #when classified #then status and text patterns match", () => {
    expect(isRetryableError({ status: 503 }, [503])).toBe(true)
    expect(isRetryableError("model is temporarily unavailable", [])).toBe(true)
    expect(isRetryableError({ status: 401 }, [503])).toBe(false)
  })

  test("#given an error with nested response status #when classified #then it is retryable", () => {
    expect(isRetryableError({ response: { status: 503 } }, [503])).toBe(true)
  })

  test("#given an OpenCode APIError #when classified #then data.statusCode is retryable", () => {
    expect(isRetryableError({ name: "APIError", data: { statusCode: 429, message: "busy" } }, [429])).toBe(true)
  })

  test("#given a wrapped fetch error #when the status is on error.cause #then it is retryable", () => {
    expect(isRetryableError({ message: "fetch failed", cause: { statusCode: 503 } }, [503])).toBe(true)
  })

  test("#given a nested cause chain #when a retryable status is buried deep #then it is found", () => {
    expect(isRetryableError({ cause: { cause: { status: 429 } } }, [429])).toBe(true)
  })

  test("#given an Error with a cause carrying retryable text #when classified #then it is retryable", () => {
    const err = new TypeError("fetch failed", { cause: new Error("service unavailable") })
    expect(isRetryableError(err, [])).toBe(true)
  })

  test("#given a circular cause chain #when classified #then it terminates without matching", () => {
    const err: Record<string, unknown> = { message: "boom" }
    err.cause = err
    expect(isRetryableError(err, [429])).toBe(false)
  })

  test("#given a bare 'try again' message #when classified #then it is not retryable", () => {
    expect(isRetryableError("please try again with a different prompt", [])).toBe(false)
  })

  test("#given a transient 'try again later' message #when classified #then it is retryable", () => {
    expect(isRetryableError("rate exceeded, please try again later", [])).toBe(true)
    expect(isRetryableError("try again in 20 seconds", [])).toBe(true)
  })

  test("#given custom retry_on_patterns #when normalized #then they extend the defaults", () => {
    const config = normalizeOptions({ retry_on_patterns: ["capacity constraints", "(invalid"] })
    // default pattern still works
    expect(isRetryableError("overloaded", [], config.retryPatterns)).toBe(true)
    // custom pattern matches
    expect(isRetryableError("hit capacity constraints", [], config.retryPatterns)).toBe(true)
    // invalid regex source was skipped, not crashed on
    expect(isRetryableError("something else", [], config.retryPatterns)).toBe(false)
  })

  test("#given backoff disabled #when computed #then it returns 0", () => {
    const config = normalizeOptions({ backoff_ms: 0 })
    expect(computeBackoff(config, 0, () => 0.5)).toBe(0)
  })

  test("#given backoff enabled #when computed #then it grows exponentially within the equal-jitter band", () => {
    const config = normalizeOptions({ backoff_ms: 100, backoff_max_ms: 10_000 })
    // equal jitter: result in [base/2, base]; random=0 -> lower bound, random=1 -> upper bound
    expect(computeBackoff(config, 0, () => 0)).toBe(50)
    expect(computeBackoff(config, 0, () => 1)).toBe(100)
    expect(computeBackoff(config, 1, () => 0)).toBe(100) // base 200 -> half 100
    expect(computeBackoff(config, 2, () => 1)).toBe(400) // base 400 -> up to 400
  })

  test("#given backoff would exceed the cap #when computed #then it is clamped to backoff_max_ms", () => {
    const config = normalizeOptions({ backoff_ms: 1000, backoff_max_ms: 2000 })
    // base capped at 2000 regardless of attempt index; upper bound is 2000
    expect(computeBackoff(config, 10, () => 1)).toBe(2000)
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
