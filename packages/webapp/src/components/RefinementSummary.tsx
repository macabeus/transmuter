import React from 'react';

import type { RefinementReport } from '../types';

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) {
    return '∞';
  }
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}h ${m % 60}m ${s % 60}s`;
  }
  if (m > 0) {
    return `${m}m ${s % 60}s`;
  }
  return `${s}s`;
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) {
    return '∞';
  }
  return n.toLocaleString();
}

export function RefinementSummary({ report }: { report: RefinementReport }): React.ReactElement {
  const { finalResult: r, config, guideline, metadata } = report;
  const allFixed = r.violationsFixed === r.violationsTotal;
  const partial = r.violationsFixed > 0 && !allFixed;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <ProgressCard fixed={r.violationsFixed} total={r.violationsTotal} />

      <StatCard
        label="Status"
        value={allFixed ? 'All fixed' : partial ? 'Partial' : 'None fixed'}
        accent={allFixed ? 'green' : partial ? 'amber' : 'red'}
      />

      <StatCard label="Time" value={formatDuration(r.elapsed)} />

      <StatCard label="Guideline" value={guideline.id} accent="teal" />

      <StatCard label="Trivial" value={String(r.trivialFixes)} accent={r.trivialFixes > 0 ? 'green' : 'slate'} />
      <StatCard label="Matched" value={String(r.permutedFixes)} accent={r.permutedFixes > 0 ? 'green' : 'slate'} />
      <StatCard
        label="Resolved by prior"
        value={String(r.resolvedByPrior)}
        accent={r.resolvedByPrior > 0 ? 'green' : 'slate'}
      />
      <StatCard label="Not fixable" value={String(r.notFixable)} accent={r.notFixable > 0 ? 'red' : 'slate'} />

      <div className="col-span-2 md:col-span-4 bg-slate-800/50 rounded-xl border border-slate-700 p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Configuration</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <ConfigItem label="Function" value={config.functionName} />
          <ConfigItem label="Guideline" value={config.guidelineId} />
          {config.profile && <ConfigItem label="Profile" value={config.profile} />}
          <ConfigItem label="Concurrency" value={String(config.concurrency)} />
          <ConfigItem label="Max compiles/violation" value={formatNumber(config.maxCompilesPerViolation)} />
          <ConfigItem label="Timeout/violation" value={formatDuration(config.timeoutMsPerViolation)} />
          <ConfigItem label="Seed" value={String(config.seed)} />
        </div>
        {metadata.createdAt && (
          <p className="text-xs text-slate-500 mt-3 pt-3 border-t border-slate-700">
            {new Date(metadata.createdAt).toLocaleString()}
            {metadata.completedAt && ` \u2014 ${new Date(metadata.completedAt).toLocaleString()}`}
          </p>
        )}
      </div>
    </div>
  );
}

function ProgressCard({ fixed, total }: { fixed: number; total: number }): React.ReactElement {
  const pct = total > 0 ? Math.round((fixed / total) * 100) : 0;
  const color = fixed === total ? 'text-emerald-400' : fixed > 0 ? 'text-teal-300' : 'text-red-400';
  const border = fixed === total ? 'border-l-emerald-500' : fixed > 0 ? 'border-l-teal-500' : 'border-l-red-500';
  return (
    <div className={`bg-slate-800/50 rounded-xl p-4 border-l-4 ${border} border-y border-r border-slate-700`}>
      <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">Violations Fixed</p>
      <p className={`text-xl font-bold font-mono ${color}`}>
        {fixed}/{total}
        <span className="text-sm font-normal text-slate-500 ml-2">({pct}%)</span>
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent = 'slate',
}: {
  label: string;
  value: string;
  accent?: 'green' | 'amber' | 'red' | 'teal' | 'slate';
}): React.ReactElement {
  const colors = {
    green: 'text-emerald-400',
    amber: 'text-amber-300',
    red: 'text-red-400',
    teal: 'text-emerald-300',
    slate: 'text-slate-100',
  };
  const accentBorder = {
    green: 'border-l-4 border-l-emerald-500 border-y border-r border-slate-700',
    amber: 'border-l-4 border-l-amber-500 border-y border-r border-slate-700',
    red: 'border-l-4 border-l-red-500 border-y border-r border-slate-700',
    teal: 'border-l-4 border-l-emerald-500 border-y border-r border-slate-700',
    slate: 'border border-slate-700',
  };
  return (
    <div className={`bg-slate-800/50 rounded-xl p-4 ${accentBorder[accent]}`}>
      <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">{label}</p>
      <p className={`text-xl font-bold font-mono ${colors[accent]}`}>{value}</p>
    </div>
  );
}

function ConfigItem({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <span className="text-slate-500">{label}: </span>
      <span className="text-slate-300 font-mono">{value}</span>
    </div>
  );
}
