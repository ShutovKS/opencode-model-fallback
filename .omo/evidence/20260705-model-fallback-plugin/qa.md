# QA Evidence: model fallback plugin

## What Was Tested

- `bun test`: unit coverage for retryable errors, non-retryable errors, empty history, session enable/disable/reset, fallback model override, config preflight skip, and helpers.
- `bun run typecheck`: TypeScript strict check.
- `bun run build`: ESM bundle plus declaration generation.
- `bun pm pack --dry-run`: npm package contents.
- Live OpenCode smoke in isolated XDG sandbox with local `dist/index.js` plugin.

## What Was Observed

- `bun test`: 13 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun run build`: produced `dist/index.js` and declarations.
- `bun pm pack --dry-run`: package includes `package.json`, `LICENSE`, `README.md`, `dist/index.js`, `dist/index.d.ts`, `dist/plugin.d.ts`.
- OpenCode 1.17.13 sandbox config used primary `anthropic/claude-sonnet-4-5`, marked it in `unavailable_models`, and configured fallback `opencode/big-pickle`.
- `/config` showed effective model changed to `opencode/big-pickle`.
- `/experimental/tool/ids` returned `model_fallback_control`.
- `opencode run "Reply with exactly: fallback smoke" --format json` returned text `fallback smoke`.
- OpenCode log showed `stream providerID=opencode modelID=big-pickle`.
- Real OpenCode DB session count stayed unchanged: `3575 -> 3575`; sandbox DB had one QA session.

## Why It Is Enough

- Unit tests cover the plugin state machine and control tool behavior.
- Live smoke proves OpenCode can load the package entrypoint, register the tool, apply the config hook, and complete a session through the fallback model.
- Isolation proof shows QA did not write to the host OpenCode DB.

## What Was Omitted

- Raw `account.json` and credentials were not copied into evidence.
- Full OpenCode logs were summarized to avoid leaking local machine paths beyond the sandbox and auth details.
