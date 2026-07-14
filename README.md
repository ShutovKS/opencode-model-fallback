# @shutovks/opencode-model-fallback

OpenCode plugin that keeps a session alive when the current model fails with rate limits, quota exhaustion, overloads, or temporary provider errors.

It retries the last user message in the same session with the next configured fallback model.

## Install

```bash
bun add -g @shutovks/opencode-model-fallback
```

Or use any package manager OpenCode can resolve from your `plugin` config.

## Configure

Add the plugin to `opencode.json` or `.opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@shutovks/opencode-model-fallback",
      {
        "enabled": true,
        "fallback_models": [
          "anthropic/claude-sonnet-4-5",
          "openai/gpt-5.1-codex",
          "google/gemini-2.5-pro"
        ],
        "unavailable_models": [],
        "max_attempts": 3,
        "attempts_window_ms": 600000,
        "cooldown_ms": 60000,
        "backoff_ms": 0,
        "recover_original_model": true,
        "notify": true,
        "debug": false
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
| `retry_on_patterns` | `[]` | Extra case-insensitive regex sources matched against the error text, appended to the built-in patterns. Invalid regexes are skipped. |
| `max_attempts` | `3` | Max fallback retries within `attempts_window_ms`. |
| `attempts_window_ms` | `600000` | Sliding window (ms) for `max_attempts`. Older attempts stop counting once outside it. Set `0` for a lifetime cap. |
| `cooldown_ms` | `60000` | How long to avoid a failed model. |
| `backoff_ms` | `0` | Base delay for exponential backoff with equal jitter before a retry. `0` = instant (unchanged behavior). |
| `backoff_max_ms` | `30000` | Cap for the computed backoff delay. |
| `recover_original_model` | `true` | Return to the original model once its cooldown expires instead of staying on the fallback. |
| `notify` | `true` | Show a toast when switching or recovering models. |
| `debug` | `false` | Write a `[model-fallback] …` trace to stderr explaining every fallback decision. |

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
- `status`: return effective state, current model, attempts, windowed attempt count, per-model `failureCounts`, recent `switches`, and configured fallbacks.
- `reset`: clear session state and return to the config default.

Session overrides are in memory only. They disappear when the session is deleted or OpenCode restarts.

### `unavailable_models` vs `fallback_models`

These options look similar but act at different times and for different reasons:

| | `fallback_models` | `unavailable_models` |
| --- | --- | --- |
| **Purpose** | Models to retry on **when the current model fails** with a transient error. | Models to **skip up front** because they are known-bad (deprecated, no credentials, etc.). |
| **When it acts** | After a `session.error` (`event` hook) or on recovery (`chat.message`). | Before any provider call, in the `config` hook and `chat.message`. |
| **Triggered by** | A retryable error at runtime. | Static configuration, no error needed. |
| **Typical use** | "If `claude-opus` is rate-limited, try `gpt-5.1-codex`." | "Never select `claude-3-opus`; OpenCode errors before `session.error`." |

A model can be in both lists, but that's redundant: anything in `unavailable_models` is already filtered out when the plugin chooses the next fallback, so listing it again as a fallback has no effect.

## What Counts As Retryable

Fallback runs on configured status codes and common transient error text:

- rate limit / too many requests
- quota exceeded
- all credentials for model exhausted
- model unsupported
- service unavailable / overloaded / temporarily unavailable
- "try again" **with a transient qualifier** (later / soon / shortly / in Ns) — a bare "try again" does not match
- `429`, `503`, `529` in plain text errors

Status codes and text are also detected through the wrapped `error.cause` chain, so a 429/503 buried in a fetch error still triggers fallback. Add your own phrases with `retry_on_patterns`.

## Troubleshooting

**Fallback never triggers.**
Turn on `debug: true` and reproduce. The `[model-fallback] …` lines in the OpenCode log explain each skip: disabled, no `fallback_models`, "not retryable" (status/text unmatched), `max_attempts` reached, or no available model.

**Fallback triggers too aggressively.**
A provider's non-transient message may be matching a pattern. Check `debug` output, then either narrow `retry_on_errors` or add `retry_on_patterns` for only the phrases you want. Note the bare "try again" no longer matches by default.

**Session stuck on a fallback model.**
Expected only while the original model's cooldown (`cooldown_ms`) is active. Once it expires the next message recovers to the original model — unless `recover_original_model: false` or the original is in `unavailable_models`.

**Fallback stops retrying partway through a long session.**
`max_attempts` counts within `attempts_window_ms` (default 10 min). Raise `max_attempts`, lengthen `attempts_window_ms`, or set `attempts_window_ms: 0` for an absolute lifetime cap.

**A known-broken model still gets selected.**
List it in `unavailable_models` so the plugin skips it before any provider call, not only after it fails.

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

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

MIT

---

> This project is independent and is not built by, endorsed by, or affiliated with the [OpenCode](https://opencode.ai) team.
