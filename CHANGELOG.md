# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

New options are documented in the README; all default to the previous
behavior unless noted.

### Added

- **Recover to the original model after its cooldown expires.** A single
  transient error no longer pins the session to a fallback model for its
  entire lifetime. Once the original model's `cooldown_ms` elapses, the next
  `chat.message` restores it (resetting attempts and notifying via toast).
  Gated by the new `recover_original_model` option (default `true`). (#5)
- **Sliding window for `max_attempts`.** Fallback attempts are now counted
  within a time window instead of for the whole session lifetime, so a few
  early blips no longer disable fallback for hours. New
  `attempts_window_ms` option (default 10 min); set `0` to restore the
  previous absolute lifetime cap. `status` also reports `windowAttempts` and
  `attemptsWindowMs`. (#6)
- **Exponential backoff with jitter before re-prompting.** New `backoff_ms`
  (default `0` = instant, unchanged) and `backoff_max_ms` (default 30s)
  options. When set, the plugin waits before the retry. (#7)
- **Debug logging.** New `debug` option (default `false`) writes a
  single-line `[model-fallback] …` trace to stderr explaining every fallback
  decision (why a retry fired or was skipped). (#8)
- **Per-model failure counts and switch history in `status`.**
  `model_fallback_control status` now reports `failureCounts` (retryable
  errors per model) and `switches` (last 20 transitions with
  from/to/reason/timestamp; reasons: `fallback`, `unavailable`, `recovery`).
  (#9)
- **Configurable retry patterns.** New `retry_on_patterns` option appends
  user-supplied case-insensitive regex sources to the built-in patterns.
  Invalid sources are skipped rather than failing plugin init. (#4)
- **Active cooldowns in `status`.** `model_fallback_control status` now
  reports `cooling` (model → cooldown-expiry timestamp), making cooldown
  pruning observable.

### Changed

- **`try again` retry pattern narrowed.** It now requires the transient
  qualifier (`later` / `soon` / `shortly` / `moment` / `in Ns`), so a bare
  "try again" in a non-retryable message no longer triggers fallback. (#4)
- **Retryable errors are now detected through `error.cause`.** `statusCode`
  and `errorText` walk the cause chain (bounded to depth 5, safe against
  cycles), so a 429/503 buried in a wrapped fetch error triggers fallback.
  Plain-object wrappers whose `cause` is an `Error` are also handled —
  `JSON.stringify` serializes nested `Error`s to `{}`, which previously
  dropped retryable text. (#3)

### Fixed

- **Recovery works in the live runtime.** OpenCode invokes the
  `chat.message` hook for the plugin's *own* retry prompt. `pendingModel` is
  now set *before* `session.promptAsync`, so that echoed hook call is no
  longer mistaken for a manual model switch (which overwrote
  `originalModel` with the fallback and silently disabled
  `recover_original_model`). Found by the new in-process e2e suite.
- **Expired model cooldowns are pruned.** `state.failedUntil` no longer
  accumulates one entry per failed model for the whole session lifetime. (#2)

### Tests

- **In-process e2e suite against a real headless OpenCode server**
  (`test/e2e-server.test.ts`): boots `opencode serve` via
  `createOpencodeServer`, drives it through the SDK client, observes plugin
  decisions through the SSE event stream (`session.error`, `tui.toast.show`,
  `message.updated`). Covers status-path fallback, `retry_on_patterns`,
  cascade fallback, and recovery — the paths unit mocks could not validate.

## [1.0.8] - 2026-07-13

### Added

- Initial public release of the OpenCode model-fallback plugin.
- Session control tool `model_fallback_control` (enable / disable / status /
  reset).
- `unavailable_models` handled both in the `config` hook and `chat.message`.
