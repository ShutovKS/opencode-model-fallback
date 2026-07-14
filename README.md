# @shutovks/opencode-model-fallback

> Keep your OpenCode session alive when the model fails — automatic fallback to the next configured model on rate limits, quota exhaustion, overloads, and transient provider errors.

[![CI](https://github.com/ShutovKS/opencode-model-fallback/actions/workflows/ci.yml/badge.svg)](https://github.com/ShutovKS/opencode-model-fallback/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@shutovks/opencode-model-fallback)](https://www.npmjs.com/package/@shutovks/opencode-model-fallback)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-fa9b3f)](https://bun.sh)

When the active model errors out with a transient failure, this plugin retries the last user message in the same session using the next model from your fallback list — then recovers back to the original once it's healthy again. No lost context, no manual restart.

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
| `backoff_ms` | `0` | Base delay for exponential backoff with equal jitter before a retry. `0` = instant. |
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

| Action | Effect |
| --- | --- |
| `enable` | Enable fallback for the current session. |
| `disable` | Disable fallback for the current session. |
| `status` | Return effective state, current model, attempts, windowed attempt count, per-model failure counts, active cooldowns, recent switches, and configured fallbacks. |
| `reset` | Clear session state and return to the config default. |

Session overrides live in memory only — they disappear when the session is deleted or OpenCode restarts.

### `unavailable_models` vs `fallback_models`

They look similar but act at different times:

| | `fallback_models` | `unavailable_models` |
| --- | --- | --- |
| **Purpose** | Retry on these **when the current model fails** with a transient error. | **Skip these up front** because they are known-bad (deprecated, no credentials, etc.). |
| **When** | After a `session.error` or on recovery. | Before any provider call. |
| **Trigger** | A retryable error at runtime. | Static configuration — no error needed. |
| **Example** | "If `claude-opus` is rate-limited, try `gpt-5.1-codex`." | "Never select `claude-3-opus`; OpenCode errors before `session.error`." |

A model can be in both lists, but that's redundant — anything in `unavailable_models` is already filtered out when the plugin picks the next fallback.

## What Counts As Retryable

Fallback triggers on configured status codes and common transient error text:

- rate limit / too many requests
- quota exceeded
- all credentials for model exhausted
- model unsupported
- service unavailable / overloaded / temporarily unavailable
- "try again" **with a transient qualifier** (later / soon / shortly / in Ns) — a bare "try again" does **not** match
- `429`, `503`, `529` in plain text errors

Status codes and text are also detected through the wrapped `error.cause` chain, so a 429/503 buried in a fetch error still triggers fallback. Add your own phrases with `retry_on_patterns`.

## Troubleshooting

<details>
<summary><b>Fallback never triggers</b></summary>

Turn on `debug: true` and reproduce. The `[model-fallback] …` lines in the OpenCode log explain each skip: disabled, no `fallback_models`, "not retryable" (status/text unmatched), `max_attempts` reached, or no available model.
</details>

<details>
<summary><b>Fallback triggers too aggressively</b></summary>

A provider's non-transient message may be matching a pattern. Check `debug` output, then either narrow `retry_on_errors` or set `retry_on_patterns` to only the phrases you want. Note that a bare "try again" no longer matches by default.
</details>

<details>
<summary><b>Session stuck on a fallback model</b></summary>

Expected only while the original model's cooldown (`cooldown_ms`) is active. Once it expires the next message recovers to the original model — unless `recover_original_model: false` or the original is in `unavailable_models`.
</details>

<details>
<summary><b>Fallback stops retrying partway through a long session</b></summary>

`max_attempts` counts within `attempts_window_ms` (default 10 min). Raise `max_attempts`, lengthen `attempts_window_ms`, or set `attempts_window_ms: 0` for an absolute lifetime cap.
</details>

<details>
<summary><b>A known-broken model still gets selected</b></summary>

List it in `unavailable_models` so the plugin skips it before any provider call, not only after it fails.
</details>

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

[MIT](LICENSE)

---

> This project is independent and is not built by, endorsed by, or affiliated with the [OpenCode](https://opencode.ai) team.
