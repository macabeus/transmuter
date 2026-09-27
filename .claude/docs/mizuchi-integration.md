# Mizuchi ↔ Transmuter

**Current status: no live integration.** Mizuchi and Transmuter are independent projects. The two notable overlaps:

1. **Scoring.** Transmuter scores through `@matchkit/scoring`; Mizuchi still has its own objdiff wrapper (`src/shared/objdiff.ts`), which Transmuter's former `Objdiff` class was ported from. Moving Mizuchi to `@matchkit/scoring` is the planned way to make the two score alike.
2. **Mizuchi currently wraps the Python `decomp-permuter`,** not Transmuter. `mizuchi/src/shared/decomp-permuter.ts` spawns the upstream Python process. `mizuchi/src/plugins/decomp-permuter/decomp-permuter-plugin.ts` is the Mizuchi plugin that consumes it. There is no `@transmuter/core` dependency in Mizuchi at the time of writing — `grep -r transmuter mizuchi/src` returns nothing.

If the user is asking you to wire Mizuchi to Transmuter, this doc is a sketch of how the bridge would look — **not** a description of code that exists. Do not cite this as "already done."

## Expected bridge pattern (not implemented)

Based on how Mizuchi's other plugins (`decomp-permuter`, `m2c`, `claude-runner`) are structured, a `transmuter` plugin would:

1. Export a `TransmuterPlugin` class implementing `Plugin<TransmuterResult>` from Mizuchi's `src/shared/types.ts`.
2. In `execute(context)`, construct a `MutationSearch` from `@transmuter/core` using the current pipeline context's source code, target `.o`, compiler command, and function name.
3. Wire `onEvent` to the Mizuchi plugin's progress reporting and task cancellation.
4. On completion, return the best candidate source (or the whole `SessionReport`) so downstream plugins — `claude-runner` in particular — can feed it to the LLM as improved context.
5. Optionally expose Transmuter's HTTP API (`--api`) so a running Mizuchi pipeline can be controlled externally the same way Mizuchi currently supports Python permuter control.

The interesting design questions when actually building this:

- **Should Transmuter's candidate graph be exposed to Claude?** The `claude-runner` plugin's MCP tool currently returns objdiff output. Adding a "here are N improved candidates and why" tool would close the feedback loop.
- **Where does the pipeline retry?** Mizuchi already has a plugin-manager retry loop. If Transmuter's search exhausts, should Mizuchi retry with a new LLM round, or should Claude inject hypotheses via `POST /inject` during the Transmuter run?
- **Cross-plugin state.** Mizuchi uses per-plugin result types keyed by plugin ID (`PluginResultMap`). Transmuter's `SessionReport` is a large JSON — whether to store it in Mizuchi's context verbatim or summarize it is a project decision.

Until someone writes the plugin, none of the above exists in code.

## Scoring

Transmuter scores through [`@matchkit/scoring`](https://github.com/macabeus/matchkit/tree/main/packages/scoring). Mizuchi's `src/shared/objdiff.ts` (and `objdiff-service.ts`) is a separate wrapper, and it can score the same pair differently: it takes objdiff-wasm as a range (`^3.8.0`) and puts the candidate on objdiff's left side, where `@matchkit/scoring` puts the target. A Mizuchi–Transmuter bridge should score through `@matchkit/scoring` on both sides.

## If you're told to "integrate Mizuchi with Transmuter"

1. Check both repos for a `transmuter` plugin directory first — this doc may have gone stale.
2. Read `mizuchi/src/plugins/decomp-permuter/decomp-permuter-plugin.ts` end-to-end. It's the closest structural analogue and shows the plugin interface the new plugin must implement.
3. Decide whether to consume `@transmuter/core` as a runtime dependency (npm/pnpm link for local dev) or to spawn `transmuter match --api` as a subprocess and talk to it via the HTTP API. The subprocess approach is safer for process isolation; the library approach is faster and lets Mizuchi drive the search directly via the JS API.
4. Wire events into Mizuchi's `Plugin<T>` lifecycle — `execute`, `prepareRetry`, `getReportSections`.
5. Add tests using `src/shared/mock-plugin.ts` (Mizuchi's pattern) plus at least one fixture that exercises the real `MutationSearch`.

## Pitfalls

- **Don't claim integration exists when it doesn't.** Grep both repos before describing data flow between them. This document will age badly; verify against the filesystem.
- **`@transmuter/core` is published but Mizuchi doesn't use it.** Mizuchi's `package.json` has no `@transmuter/*` dependency as of writing. If someone "removed" it, it never existed in the first place.
- **The `decomp-permuter` wrapper in Mizuchi is unrelated to Transmuter.** It calls the upstream Python tool. Don't conflate them.
