/**
 * `transmuter ctl` — thin HTTP client for the control server.
 *
 * Reads the discovery file, sends a request, and prints the JSON response.
 * Designed for LLM agents and shell scripts.
 */
import fs from 'fs/promises';
import path from 'path';

export interface CtlArgs {
  action: string;
  params: string[];
  controlFile?: string;
  cwd?: string;
}

interface DiscoveryFile {
  pid: number;
  port: number;
  sessionId: string;
  startedAt: string;
}

async function findDiscoveryFile(controlFile?: string, cwd?: string): Promise<DiscoveryFile> {
  const filePath = controlFile ?? path.join(cwd ?? process.cwd(), 'transmuter-control.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as DiscoveryFile;
  } catch {
    throw new Error(`Cannot read discovery file at ${filePath}. Is the transmuter running with --api?`);
  }
}

async function httpRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : {},
    body: payload,
  });
  const raw = await res.text();
  try {
    return { status: res.status, data: JSON.parse(raw) };
  } catch {
    return { status: res.status, data: raw };
  }
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

interface ActionDef {
  method: 'GET' | 'POST';
  path: string | ((params: string[]) => string);
  body?: (params: string[]) => unknown;
  description: string;
}

const ACTIONS: Record<string, ActionDef> = {
  session: { method: 'GET', path: '/session', description: 'Get current session snapshot' },
  candidates: { method: 'GET', path: '/candidates', description: 'List all candidates' },
  best: { method: 'GET', path: '/candidates/best', description: 'Get best candidate' },
  candidate: {
    method: 'GET',
    path: (p) => `/candidates/${encodeURIComponent(p[0] ?? '')}`,
    description: 'Get candidate by ID',
  },
  lineage: {
    method: 'GET',
    path: (p) => `/candidates/${encodeURIComponent(p[0] ?? '')}/lineage`,
    description: 'Get candidate lineage',
  },
  children: {
    method: 'GET',
    path: (p) => `/candidates/${encodeURIComponent(p[0] ?? '')}/children`,
    description: 'Get candidate children',
  },
  assembly: {
    method: 'GET',
    path: (p) => `/candidates/${encodeURIComponent(p[0] ?? '')}/assembly`,
    description: 'Get assembly diff for a candidate (arg: candidate-id)',
  },
  graph: { method: 'GET', path: '/graph', description: 'Get full candidate graph' },
  'context-source': {
    method: 'GET',
    path: '/context-source',
    description: 'Get the pre-isolation source (present only when --isolate was used)',
  },
  rules: { method: 'GET', path: '/rules', description: 'Get rule stats' },
  timeline: { method: 'GET', path: '/timeline', description: 'Get score timeline' },
  report: { method: 'GET', path: '/report', description: 'Get full session report' },
  pause: { method: 'POST', path: '/pause', description: 'Pause the session' },
  resume: { method: 'POST', path: '/resume', description: 'Resume the session' },
  stop: { method: 'POST', path: '/stop', description: 'Stop the session' },
  prune: {
    method: 'POST',
    path: '/branches/prune',
    body: (p) => {
      // "prune 40" → maxScore: 40, "prune best 10" → keepBestN: 10
      if (p[0] === 'best') {
        return { keepBestN: Number(p[1] ?? 10) };
      }
      return { maxScore: Number(p[0] ?? 40) };
    },
    description: 'Prune branches (arg: max-score OR "best N")',
  },
  inject: {
    method: 'POST',
    path: '/inject',
    body: (p) => {
      // First param is source code (or @file path), second is optional label
      const source = p[0] ?? '';
      const label = p[1];
      return { source, label };
    },
    description: 'Inject source code (arg: source-code [label])',
  },
  'inject-file': {
    method: 'POST',
    path: '/inject',
    body: () => ({}), // Placeholder — actual body built in ctlCommand
    description: 'Inject source from file (arg: file-path [label])',
  },
  'disable-branch': {
    method: 'POST',
    path: (p) => `/branches/${encodeURIComponent(p[0] ?? '')}/disable`,
    description: 'Disable a branch (arg: target-id)',
  },
  'enable-branch': {
    method: 'POST',
    path: (p) => `/branches/${encodeURIComponent(p[0] ?? '')}/enable`,
    description: 'Enable a branch (arg: target-id)',
  },
  'set-weight': {
    method: 'POST',
    path: (p) => `/branches/${encodeURIComponent(p[0] ?? '')}/weight`,
    body: (p) => ({ weight: Number(p[1] ?? 1) }),
    description: 'Set branch weight (arg: target-id weight)',
  },
  'update-rules': {
    method: 'POST',
    path: '/rules/weights',
    body: (p) => {
      // Parse "ruleId=weight ruleId=weight ..."
      const weights: Record<string, number> = {};
      for (const pair of p) {
        const [id, w] = pair.split('=');
        if (id && w !== undefined) {
          weights[id] = Number(w);
        }
      }
      return weights;
    },
    description: 'Update rule weights (arg: ruleId=weight ...)',
  },
  'enable-rule': {
    method: 'POST',
    path: (p) => `/rules/${encodeURIComponent(p[0] ?? '')}/enable`,
    description: 'Enable a rule (arg: rule-id)',
  },
  'disable-rule': {
    method: 'POST',
    path: (p) => `/rules/${encodeURIComponent(p[0] ?? '')}/disable`,
    description: 'Disable a rule (arg: rule-id)',
  },
};

const CTL_USAGE = `
Usage: transmuter ctl <action> [args...] [--control-file <path>]

Actions:
  session                      Get current session snapshot
  candidates                   List all candidates
  best                         Get best candidate
  candidate <id>               Get candidate by ID
  lineage <id>                 Get candidate lineage
  children <id>                Get candidate children
  assembly <id>                Get assembly diff for a candidate
  graph                        Get full candidate graph
  context-source               Get pre-isolation source (--isolate runs only)
  rules                        Get rule stats
  timeline                     Get score timeline
  report                       Get full session report
  pause                        Pause the session
  resume                       Resume the session
  stop                         Stop the session
  prune <max-score>            Disable branches with score >= N
  prune best <N>               Keep only N best branches
  inject <source> [label]      Inject source code
  inject-file <path> [label]   Inject source from file
  disable-branch <target-id>   Disable a branch
  enable-branch <target-id>    Enable a branch
  set-weight <target-id> <w>   Set branch weight
  update-rules <id=w> ...      Update rule weights
  enable-rule <rule-id>        Enable a rule
  disable-rule <rule-id>       Disable a rule

Options:
  --control-file <path>  Path to transmuter-control.json (default: ./transmuter-control.json)
`.trim();

export async function ctlCommand(args: CtlArgs): Promise<void> {
  if (!args.action || args.action === '--help' || args.action === '-h') {
    console.log(CTL_USAGE);
    process.exit(0);
  }

  const actionDef = ACTIONS[args.action];
  if (!actionDef) {
    console.error(`Unknown action: ${args.action}\n`);
    console.log(CTL_USAGE);
    process.exit(1);
  }

  const discovery = await findDiscoveryFile(args.controlFile);

  const urlPath = typeof actionDef.path === 'function' ? actionDef.path(args.params) : actionDef.path;

  let body: unknown;
  if (args.action === 'inject-file') {
    // Read source from file
    const filePath = args.params[0];
    if (!filePath) {
      console.error('Error: inject-file requires a file path');
      process.exit(1);
    }
    const source = await fs.readFile(filePath, 'utf-8');
    body = { source, label: args.params[1] };
  } else if (actionDef.body) {
    body = actionDef.body(args.params);
  }

  const result = await httpRequest(discovery.port, actionDef.method, urlPath, body);
  console.log(JSON.stringify(result.data, null, 2));

  if (result.status >= 400) {
    process.exit(1);
  }
}
