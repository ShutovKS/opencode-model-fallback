# opencode-model-fallback

OpenCode plugin that keeps a session alive when the current model fails with rate limits, quota exhaustion, overloads, or temporary provider errors.

It retries the last user message in the same session with the next configured fallback model.

## Install

```bash
bun add -g opencode-model-fallback
```

Or use any package manager OpenCode can resolve from your `plugin` config.

## Configure

Add the plugin to `opencode.json` or `.opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-model-fallback",
      {
        "enabled": true,
        "fallback_models": [
          "anthropic/claude-sonnet-4-5",
          "openai/gpt-5.1-codex",
          "google/gemini-2.5-pro"
        ],
        "unavailable_models": [],
        "max_attempts": 3,
        "cooldown_ms": 60000,
        "notify": true
      }
    ]
  ]
}
```

Restart OpenCode after changing config.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Default behavior for new sessions. |
| `fallback_models` | `[]` | Ordered fallback model list, each as `provider/model`. |
| `unavailable_models` | `[]` | Exact model IDs to skip in the config hook before the first provider call. Useful when OpenCode fails before emitting `session.error`. |
| `retry_on_errors` | `[429, 500, 502, 503, 504]` | HTTP status codes that trigger fallback. |
| `max_attempts` | `3` | Max fallback retries per session. |
| `cooldown_ms` | `60000` | How long to avoid a failed model. |
| `notify` | `true` | Show a toast when switching models. |

## Session Control

The plugin registers one tool:

```text
model_fallback_control(action: "enable" | "disable" | "status" | "reset")
```

Use it from inside OpenCode to control fallback for the current session:

```text
Use model_fallback_control to disable fallback in this session.
```

Actions:

- `enable`: enable fallback for the current session.
- `disable`: disable fallback for the current session.
- `status`: return effective state, current model, attempts, and configured fallbacks.
- `reset`: clear session state and return to the config default.

Session overrides are in memory only. They disappear when the session is deleted or OpenCode restarts.

## What Counts As Retryable

Fallback runs on configured status codes and common transient error text:

- rate limit / too many requests
- quota exceeded
- all credentials for model exhausted
- model unsupported
- service unavailable / overloaded / temporarily unavailable
- `429`, `503`, `529` in plain text errors

## Limitations

OpenCode does not let a plugin swap the model inside a failed stream. This plugin starts a new prompt in the same session with the last user message and the fallback model.

It does not restore a half-finished tool-call turn. If the model failed after starting tool calls, the retry is a new model turn from the last user request.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

## License

MIT
