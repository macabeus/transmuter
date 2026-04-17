/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── Global ──────────────────────────────────────────────
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the codebase harder to reason about.',
      from: {},
      to: { circular: true },
    },

    // ── L0 Foundation: types.ts, language.ts, rng.ts ────────
    {
      name: 'foundation-no-upward-deps',
      severity: 'error',
      comment:
        'Foundation modules (types, language, rng) must not depend on any higher layer.',
      from: { path: '^src/(types|language|rng)\\.ts$' },
      to: {
        path: '^src/(parser|compiler|scoring|profiles|rules|guidelines|pipeline|session|search|refiner|cleanup|reducer)/',
      },
    },

    // ── L1 Infrastructure: parser.ts, compiler/, scoring/, profiles/ ──
    {
      name: 'infrastructure-no-upward-deps',
      severity: 'error',
      comment:
        'Infrastructure (parser, compiler, scoring, profiles) must not depend on domain or orchestration layers.',
      from: { path: '^src/(parser\\.ts|compiler/|scoring/|profiles/)' },
      to: {
        path: '^src/(rules/|guidelines/|pipeline/|session/|search/|refiner/|cleanup/|reducer/)',
      },
    },

    // ── L2 Domain: rules/, guidelines/, pipeline/, session/ ─
    {
      name: 'domain-no-orchestration-deps',
      severity: 'error',
      comment: 'Domain layer must not depend on orchestration layer.',
      from: { path: '^src/(rules|guidelines|pipeline|session)/' },
      to: { path: '^src/(search|refiner|cleanup|reducer)/' },
    },

    // ── Plugin isolation ────────────────────────────────────
    {
      name: 'built-in-rules-no-cross-import',
      severity: 'error',
      comment:
        'Individual built-in rules must not import from each other — only from rule.ts, helpers, and foundation.',
      from: { path: '^src/rules/built-in/(?!index\\.ts).+\\.ts$' },
      to: { path: '^src/rules/built-in/(?!index\\.ts).+\\.ts$' },
    },
    {
      name: 'built-in-guidelines-no-cross-import',
      severity: 'error',
      comment: 'Individual built-in guidelines must not import from each other.',
      from: { path: '^src/guidelines/built-in/(?!index\\.ts).+\\.ts$' },
      to: { path: '^src/guidelines/built-in/(?!index\\.ts).+\\.ts$' },
    },

    // ── Directional constraints within L2 ───────────────────
    {
      name: 'pipeline-no-rules-dep',
      severity: 'error',
      comment:
        'Pipeline data structures (pool, dedup) must not import from the rule system.',
      from: { path: '^src/pipeline/' },
      to: { path: '^src/rules/' },
    },
    {
      name: 'pipeline-no-guidelines-dep',
      severity: 'error',
      comment: 'Pipeline data structures must not import from guidelines.',
      from: { path: '^src/pipeline/' },
      to: { path: '^src/guidelines/' },
    },
    {
      name: 'session-no-rules-dep',
      severity: 'error',
      comment: 'Session reporting must not depend on the rule system.',
      from: { path: '^src/session/' },
      to: { path: '^src/rules/' },
    },
    {
      name: 'session-no-pipeline-dep',
      severity: 'error',
      comment: 'Session reporting must not depend on pipeline internals.',
      from: { path: '^src/session/' },
      to: { path: '^src/pipeline/' },
    },

    // ── Worker / main-thread boundary ───────────────────────
    // slot-worker.ts runs inside a Bun Worker thread; the orchestrator loads it
    // by URL, never by static import. `worker-protocol.ts` is the only module
    // allowed to be shared across the boundary (type-only).
    {
      name: 'worker-no-main-thread-imports',
      severity: 'error',
      comment:
        'slot-worker.ts runs in a Worker thread and must not depend on main-only modules (Pool, SessionStore, MutationSearch, the orchestrator itself, refiner/cleanup/reducer, isolate, or the public index barrel).',
      from: { path: '^src/search/slot-worker\\.ts$' },
      to: {
        path: [
          '^src/pipeline/pool\\.ts$',
          '^src/session/',
          '^src/refiner/',
          '^src/cleanup/',
          '^src/reducer/',
          '^src/isolate/',
          '^src/search/(mutation-search|slot-orchestrator|auto-compact)\\.ts$',
          '^src/index\\.ts$',
        ].join('|'),
      },
    },
    {
      name: 'slot-worker-is-entry-point-only',
      severity: 'error',
      comment:
        'slot-worker.ts is a Worker entry point loaded by URL — nothing in main-thread code should import it statically (doing so would pull its runtime into the main bundle and defeat the boundary).',
      from: {},
      to: { path: '^src/search/slot-worker\\.ts$' },
    },

    // ── Orchestration isolation ─────────────────────────────
    {
      name: 'reducer-no-search-dep',
      severity: 'error',
      comment:
        'Reducer is self-contained — must not import MutationSearch or other orchestrators.',
      from: { path: '^src/reducer/' },
      to: { path: '^src/(search|refiner|cleanup)/' },
    },
    {
      name: 'refiner-no-cleanup-dep',
      severity: 'error',
      comment:
        'Refiner must not depend on cleanup internals (cleanup is composed at CLI level).',
      from: { path: '^src/refiner/' },
      to: { path: '^src/cleanup/' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    exclude: { path: '\\.spec\\.ts$' },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
