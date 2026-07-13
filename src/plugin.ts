import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

export type Options = {
  enabled?: boolean
  fallback_models?: string[]
  unavailable_models?: string[]
  retry_on_errors?: number[]
  retry_on_patterns?: string[]
  max_attempts?: number
  cooldown_ms?: number
  recover_original_model?: boolean
  notify?: boolean
}

type Config = {
  enabled: boolean
  fallbackModels: string[]
  unavailableModels: string[]
  retryOnErrors: number[]
  retryPatterns: RegExp[]
  maxAttempts: number
  cooldownMs: number
  recoverOriginal: boolean
  notify: boolean
}

type ModelRef = {
  providerID: string
  modelID: string
}

type PromptPart = {
  type: string
  text?: string
  [key: string]: unknown
}

type SessionState = {
  originalModel?: string
  currentModel?: string
  agent?: string
  attempts: number
  failedUntil: Map<string, number>
  enabledOverride?: boolean
  pendingModel?: string
  awaitingModel?: string
}

type LastUserPayload = {
  parts: PromptPart[]
  messageID?: string
}

type RuntimeEventInput = {
  event: {
    type: string
    properties?: unknown
  }
}

type ChatMessageInput = {
  sessionID: string
  agent?: string
  model?: ModelRef
}

type ChatMessageOutput = {
  message: {
    model?: ModelRef
  }
  parts: PromptPart[]
}

type OpenCodeConfigInput = {
  model?: string
  agent?: Record<string, { model?: string } | undefined>
}

type RuntimeInput = {
  directory: string
  client: {
    session: {
      messages(input: unknown): Promise<unknown>
      promptAsync(input: unknown): Promise<unknown>
    }
    tui?: {
      showToast?(input: {
        body: {
          title: string
          message: string
          variant: "warning"
          duration: number
        }
      }): Promise<unknown>
    }
  }
}

const RETRYABLE_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /quota.?exceeded/i,
  /exceeded.*quota/i,
  /usage\s*quota/i,
  /all.*credentials.*for.*model/i,
  /cool(?:ing)?.?down/i,
  /model.{0,20}?not.{0,10}?supported/i,
  /model_not_supported/i,
  /service.?unavailable/i,
  /overloaded/i,
  /temporarily.?unavailable/i,
  // Narrowed: only match the transient "try again later/soon/in Ns" phrasing,
  // not a bare "try again" which appears in non-retryable messages too.
  /try.?again\b[\s,]*(?:later|soon|shortly|moment|in\b)/i,
  /(?:^|\s)429(?:\s|$)/,
  /(?:^|\s)503(?:\s|$)/,
  /(?:^|\s)529(?:\s|$)/,
]

const DEFAULT_CONFIG: Config = {
  enabled: true,
  fallbackModels: [],
  unavailableModels: [],
  retryOnErrors: [429, 500, 502, 503, 504],
  retryPatterns: RETRYABLE_PATTERNS,
  maxAttempts: 3,
  cooldownMs: 60_000,
  recoverOriginal: true,
  notify: true,
}

function compileRetryPatterns(sources: unknown): RegExp[] {
  if (!Array.isArray(sources)) return []
  return sources.reduce<RegExp[]>((acc, source) => {
    if (typeof source !== "string" || source.length === 0) return acc
    try {
      acc.push(new RegExp(source, "i"))
    } catch {
      // Ignore invalid regex sources instead of crashing plugin init.
    }
    return acc
  }, [])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function normalizeOptions(options: Options = {}): Config {
  const fallbackModels = Array.isArray(options.fallback_models) ? options.fallback_models : DEFAULT_CONFIG.fallbackModels
  const unavailableModels = Array.isArray(options.unavailable_models) ? options.unavailable_models : DEFAULT_CONFIG.unavailableModels

  return {
    enabled: options.enabled ?? DEFAULT_CONFIG.enabled,
    fallbackModels: fallbackModels.filter((model): model is string => typeof model === "string" && parseModel(model) !== undefined),
    unavailableModels: unavailableModels.filter((model): model is string => typeof model === "string" && parseModel(model) !== undefined),
    retryOnErrors: options.retry_on_errors ?? DEFAULT_CONFIG.retryOnErrors,
    retryPatterns: [...RETRYABLE_PATTERNS, ...compileRetryPatterns(options.retry_on_patterns)],
    maxAttempts: options.max_attempts ?? DEFAULT_CONFIG.maxAttempts,
    cooldownMs: options.cooldown_ms ?? DEFAULT_CONFIG.cooldownMs,
    recoverOriginal: options.recover_original_model ?? DEFAULT_CONFIG.recoverOriginal,
    notify: options.notify ?? DEFAULT_CONFIG.notify,
  }
}

export function parseModel(model: string): ModelRef | undefined {
  const [providerID, ...modelParts] = model.split("/")
  if (!providerID || modelParts.length === 0) return undefined
  return { providerID, modelID: modelParts.join("/") }
}

export function normalizeModel(model: unknown): string | undefined {
  if (typeof model === "string") return model
  if (!isRecord(model)) return undefined

  const providerID = stringField(model, "providerID")
  const modelID = stringField(model, "modelID") ?? stringField(model, "id")
  return providerID && modelID ? `${providerID}/${modelID}` : undefined
}

export function resolveSessionID(properties: unknown): string | undefined {
  const props = isRecord(properties) ? properties : undefined
  const info = isRecord(props?.info) ? props.info : undefined

  return stringField(props, "sessionID")
    ?? stringField(info, "sessionID")
    ?? stringField(info, "id")
}

export function resolveEventModel(properties: unknown): string | undefined {
  const props = isRecord(properties) ? properties : undefined
  const info = isRecord(props?.info) ? props.info : undefined

  const providerID = stringField(props, "providerID")
  const modelID = stringField(props, "modelID")

  return normalizeModel(props?.model)
    ?? normalizeModel(info?.model)
    ?? (providerID && modelID ? `${providerID}/${modelID}` : undefined)
}

const MAX_CAUSE_DEPTH = 5

function numericField(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function ownStatusCode(error: Record<string, unknown>): number | undefined {
  const direct = numericField(error.statusCode ?? error.status ?? error.code)
  if (direct !== undefined) return direct

  const data = isRecord(error.data) ? error.data : undefined
  const dataStatus = numericField(data?.statusCode ?? data?.status ?? data?.code)
  if (dataStatus !== undefined) return dataStatus

  const response = isRecord(error.response) ? error.response : undefined
  return numericField(response?.status)
}

function statusCode(error: unknown, depth = 0): number | undefined {
  if (!isRecord(error)) return undefined

  const own = ownStatusCode(error)
  if (own !== undefined) return own

  if (depth >= MAX_CAUSE_DEPTH) return undefined
  return statusCode(error.cause, depth + 1)
}

function errorText(error: unknown, depth = 0): string {
  if (typeof error === "string") return error

  if (error instanceof Error) {
    let text = `${error.name} ${error.message}`
    if (depth < MAX_CAUSE_DEPTH && error.cause !== undefined) {
      const causeText = errorText(error.cause, depth + 1)
      if (causeText) text = `${text} ${causeText}`
    }
    return text
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function isRetryableError(error: unknown, retryOnErrors: number[], patterns: RegExp[] = RETRYABLE_PATTERNS): boolean {
  const status = statusCode(error)
  if (status !== undefined && retryOnErrors.includes(status)) return true

  const text = errorText(error)
  return patterns.some((pattern) => pattern.test(text))
}

function extractMessages(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (isRecord(response) && Array.isArray(response.data)) return response.data
  return []
}

function extractParts(value: unknown): PromptPart[] {
  if (!Array.isArray(value)) return []

  return value.filter((part): part is PromptPart => {
    return isRecord(part) && typeof part.type === "string"
  })
}

export function getLastUserPayload(messagesResponse: unknown): LastUserPayload {
  const lastUserMessage = extractMessages(messagesResponse)
    .filter((message) => isRecord(message) && isRecord(message.info) && message.info.role === "user")
    .pop()

  if (!isRecord(lastUserMessage)) return { parts: [] }

  const info = isRecord(lastUserMessage.info) ? lastUserMessage.info : undefined
  const messageParts = extractParts(lastUserMessage.parts)
  const infoID = stringField(info, "id")
  const parts = messageParts.length > 0
    ? messageParts
    : extractParts(info?.parts)

  return {
    parts,
    ...(infoID ? { messageID: infoID } : {}),
  }
}

function getState(states: Map<string, SessionState>, sessionID: string, model?: string, agent?: string): SessionState {
  let state = states.get(sessionID)
  if (!state) {
    state = {
      originalModel: model,
      currentModel: model,
      agent,
      attempts: 0,
      failedUntil: new Map(),
    }
    states.set(sessionID, state)
    return state
  }

  if (agent) state.agent = agent
  if (!state.originalModel && model) state.originalModel = model
  if (!state.currentModel && model) state.currentModel = model
  return state
}

function isEnabled(config: Config, state: SessionState | undefined): boolean {
  return state?.enabledOverride ?? config.enabled
}

function pruneExpiredCooldowns(state: SessionState, now: number): void {
  for (const [model, until] of state.failedUntil) {
    if (until <= now) state.failedUntil.delete(model)
  }
}

function nextModel(config: Config, state: SessionState): string | undefined {
  const now = Date.now()
  return config.fallbackModels.find((model) => {
    if (model === state.currentModel) return false
    if (config.unavailableModels.includes(model)) return false
    return (state.failedUntil.get(model) ?? 0) <= now
  })
}

function firstFallbackFor(config: Config, model: string): string | undefined {
  return config.fallbackModels.find((fallbackModel) => {
    if (fallbackModel === model) return false
    return !config.unavailableModels.includes(fallbackModel)
  })
}

function fallbackForUnavailable(config: Config, model: string | undefined): string | undefined {
  if (!model || !config.unavailableModels.includes(model)) return undefined
  return firstFallbackFor(config, model)
}

function resetState(state: SessionState): void {
  state.currentModel = state.originalModel
  state.attempts = 0
  state.failedUntil.clear()
  state.enabledOverride = undefined
  state.pendingModel = undefined
  state.awaitingModel = undefined
}

function statusText(config: Config, state: SessionState | undefined): string {
  const enabled = isEnabled(config, state)
  return JSON.stringify({
    enabled,
    defaultEnabled: config.enabled,
    override: state?.enabledOverride ?? null,
    currentModel: state?.currentModel ?? null,
    originalModel: state?.originalModel ?? null,
    attempts: state?.attempts ?? 0,
    maxAttempts: config.maxAttempts,
    fallbackModels: config.fallbackModels,
    unavailableModels: config.unavailableModels,
  })
}

export function createModelFallbackPlugin(input: RuntimeInput, options: Options = {}) {
  const config = normalizeOptions(options)
  const states = new Map<string, SessionState>()
  const inFlight = new Set<string>()

  async function showToast(message: string): Promise<void> {
    if (!config.notify) return

    await input.client.tui?.showToast?.({
      body: {
        title: "Model Fallback",
        message,
        variant: "warning",
        duration: 5000,
      },
    }).catch(() => undefined)
  }

  async function retryWithModel(sessionID: string, state: SessionState, model: string): Promise<boolean> {
    const parsed = parseModel(model)
    if (!parsed) return false

    const messages = await input.client.session.messages({
      path: { id: sessionID },
      query: { directory: input.directory },
    })
    const payload = getLastUserPayload(messages)
    if (payload.parts.length === 0) return false

    await input.client.session.promptAsync({
      path: { id: sessionID },
      query: { directory: input.directory },
      body: {
        model: parsed,
        parts: payload.parts,
        ...(state.agent ? { agent: state.agent } : {}),
        ...(payload.messageID ? { messageID: payload.messageID } : {}),
      },
    })

    return true
  }

  return {
    config: async (opencodeConfig: OpenCodeConfigInput) => {
      if (!config.enabled) return

      const rootFallback = fallbackForUnavailable(config, opencodeConfig.model)
      if (rootFallback) opencodeConfig.model = rootFallback

      for (const agent of Object.values(opencodeConfig.agent ?? {})) {
        if (!agent) continue
        const agentFallback = fallbackForUnavailable(config, agent.model)
        if (agentFallback) agent.model = agentFallback
      }
    },

    tool: {
      model_fallback_control: tool({
        description: "Enable, disable, inspect, or reset model fallback for the current OpenCode session.",
        args: {
          action: tool.schema.string().describe("Session fallback action: enable, disable, status, or reset"),
        },
        execute: async (args, context) => {
          const state = getState(states, context.sessionID, undefined, context.agent)

          if (args.action === "enable") {
            state.enabledOverride = true
            return statusText(config, state)
          }

          if (args.action === "disable") {
            state.enabledOverride = false
            return statusText(config, state)
          }

          if (args.action === "reset") {
            resetState(state)
            return statusText(config, state)
          }

          if (args.action !== "status") {
            return `Unknown action: ${args.action}. Use enable, disable, status, or reset.`
          }

          return statusText(config, state)
        },
      }),
    },

    event: async ({ event }: RuntimeEventInput) => {
      const props = isRecord(event.properties) ? event.properties : {}
      const sessionID = resolveSessionID(props)
      if (!sessionID) return

      if (event.type === "session.created") {
        const info = isRecord(props.info) ? props.info : undefined
        getState(states, sessionID, resolveEventModel(props), stringField(info, "agent"))
        return
      }

      if (event.type === "session.deleted") {
        states.delete(sessionID)
        inFlight.delete(sessionID)
        return
      }

      if (event.type !== "session.error") return
      if (inFlight.has(sessionID)) return

      const state = getState(states, sessionID, resolveEventModel(props), stringField(props, "agent"))
      if (!isEnabled(config, state)) return
      if (config.fallbackModels.length === 0) return
      if (!isRetryableError(props.error, config.retryOnErrors, config.retryPatterns)) return
      if (state.attempts >= config.maxAttempts) return

      const eventModel = resolveEventModel(props)
      if (state.awaitingModel && eventModel && eventModel !== state.awaitingModel) return
      state.awaitingModel = undefined

      const now = Date.now()
      pruneExpiredCooldowns(state, now)

      const failedModel = eventModel ?? state.currentModel
      if (failedModel) {
        state.currentModel = failedModel
        state.failedUntil.set(failedModel, now + config.cooldownMs)
      }

      const model = nextModel(config, state)
      if (!model) return

      inFlight.add(sessionID)
      try {
        const accepted = await retryWithModel(sessionID, state, model)
        if (!accepted) return

        state.attempts += 1
        state.currentModel = model
        state.pendingModel = model
        state.awaitingModel = model
        await showToast(`Switched to ${model}`)
      } finally {
        inFlight.delete(sessionID)
      }
    },

    "chat.message": async (chatInput: ChatMessageInput, output: ChatMessageOutput) => {
      const requestedModel = normalizeModel(chatInput.model)
      const state = states.get(chatInput.sessionID) ?? (requestedModel
        ? getState(states, chatInput.sessionID, requestedModel, chatInput.agent)
        : undefined)
      if (!state || !isEnabled(config, state)) return

      if (requestedModel === state.pendingModel) {
        state.pendingModel = undefined
        return
      }

      if (requestedModel && config.unavailableModels.includes(requestedModel)) {
        const fallbackModel = firstFallbackFor(config, requestedModel)
        const parsed = fallbackModel ? parseModel(fallbackModel) : undefined
        if (!parsed) return

        state.originalModel = requestedModel
        state.currentModel = fallbackModel
        state.pendingModel = fallbackModel
        output.message.model = parsed
        return
      }

      if (!state.currentModel) return

      if (requestedModel && requestedModel !== state.currentModel) {
        state.originalModel = requestedModel
        state.currentModel = requestedModel
        state.attempts = 0
        state.failedUntil.clear()
        state.pendingModel = undefined
        state.awaitingModel = undefined
        return
      }

      if (state.currentModel === state.originalModel) return

      // Recovery: once the original model's cooldown has expired, return to it
      // instead of staying on the fallback for the rest of the session.
      if (config.recoverOriginal && state.originalModel && !config.unavailableModels.includes(state.originalModel)) {
        const now = Date.now()
        pruneExpiredCooldowns(state, now)
        const originalUntil = state.failedUntil.get(state.originalModel) ?? 0
        if (originalUntil <= now) {
          const restored = state.originalModel
          const parsed = parseModel(restored)
          if (parsed) {
            state.currentModel = restored
            state.attempts = 0
            state.pendingModel = undefined
            state.awaitingModel = undefined
            output.message.model = parsed
            await showToast(`Recovered to ${restored}`)
            return
          }
        }
      }

      const parsed = parseModel(state.currentModel)
      if (parsed) output.message.model = parsed
    },
  }
}

const plugin = (async (input, options) => createModelFallbackPlugin(input, options as Options)) satisfies Plugin

export const ModelFallbackPlugin = plugin
export default plugin
