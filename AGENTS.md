# AGENTS.md

## Commands
- Use Bun; `bun.lock` is the lockfile. Install with `bun install --frozen-lockfile` in CI-compatible runs.
- CI order is `bun run typecheck`, `bun test`, then `bun run build`.
- Focused tests: `bun test test/index.test.ts -t "retryable session error"`.
- There is no lint/formatter script in `package.json`; do not invent one for verification.

## Project Shape
- This is a single-package OpenCode plugin, not a monorepo.
- `src/index.ts` only re-exports the default plugin from `src/plugin.ts`; real behavior lives in `src/plugin.ts`.
- Published output is `dist/index.js` and `dist/index.d.ts`; `dist/` is generated and gitignored.
- `@opencode-ai/plugin` is a peer dependency and is marked external during `bun run build`.

## Plugin Behavior To Preserve
- Public config options are snake_case (`fallback_models`, `retry_on_errors`, etc.); `normalizeOptions` converts them to internal camelCase config.
- Model strings are `provider/model`; `parseModel` splits only the first slash so model IDs may contain slashes.
- The plugin has three OpenCode surfaces in `createModelFallbackPlugin`: `config`, `event`, and `chat.message`, plus the `model_fallback_control` tool.
- Retry fallback starts a new prompt with the last user message via `client.session.promptAsync`; it cannot resume a failed stream or half-finished tool-call turn.
- `unavailable_models` is handled both in the `config` hook for root/agent models and in `chat.message` for session-level overrides.

## Tests
- Tests are plain `bun:test` in `test/index.test.ts` and mock the OpenCode runtime directly.
- When changing fallback state, errors, model parsing, or message extraction, add or update the matching lifecycle/helper test there.
