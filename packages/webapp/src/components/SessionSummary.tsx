import React from 'react';

import type { SessionConfig, SessionMetadata, SessionSummary } from '../types';

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) {
    return '\u221e';
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
    return '\u221e';
  }
  return n.toLocaleString();
}

export function SessionSummaryView({
  summary,
  config,
  metadata,
}: {
  summary: SessionSummary;
  config: SessionConfig;
  metadata: SessionMetadata;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        label="Score"
        value={`${summary.baseScore} \u2192 ${summary.bestScore}`}
        accent={summary.perfectMatch ? 'green' : summary.scoreDelta > 0 ? 'brand' : 'slate'}
      />
      <StatCard
        label="Improvement"
        value={summary.scoreDelta > 0 ? `\u2193${summary.scoreDelta}` : 'none'}
        accent={summary.scoreDelta > 0 ? 'green' : 'slate'}
      />
      <StatCard label="Iterations" value={formatNumber(summary.totalIterations)} />
      <StatCard label="Time" value={formatDuration(summary.elapsed)} />
      <StatCard label="Compiled" value={formatNumber(summary.totalCompiled)} />
      <StatCard
        label="Errors"
        value={formatNumber(summary.totalErrors)}
        accent={summary.totalErrors > 0 ? 'red' : 'slate'}
      />
      <StatCard label="Deduped" value={formatNumber(summary.totalDeduped)} />
      <StatCard
        label="Improvements"
        value={String(summary.forkCount)}
        accent={summary.forkCount > 0 ? 'green' : 'slate'}
      />

      <div className="col-span-2 md:col-span-4 bg-slate-800/50 rounded-xl border border-slate-700 p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Configuration</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <ConfigItem label="Function" value={config.functionName} />
          <ConfigItem label="Profile" value={config.profile ?? 'auto'} />
          <ConfigItem label="Seed" value={String(config.seed)} />
          <ConfigItem label="Concurrency" value={String(config.concurrency)} />
          <ConfigItem label="Max Compiles" value={formatNumber(config.maxCompiles)} />
          <ConfigItem label="Timeout" value={formatDuration(config.timeoutMs)} />
          <ConfigItem label="Depth" value={String(config.mutationDepth)} />
          {summary.completionReason && <ConfigItem label="Stopped" value={summary.completionReason} />}
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

function StatCard({
  label,
  value,
  accent = 'slate',
}: {
  label: string;
  value: string;
  accent?: 'green' | 'brand' | 'red' | 'slate';
}): React.ReactElement {
  const colors = {
    green: 'text-emerald-400',
    brand: 'text-teal-300',
    red: 'text-red-400',
    slate: 'text-slate-100',
  };
  const accentBorder = {
    green: 'border-l-4 border-l-emerald-500 border-y border-r border-slate-700',
    brand: 'border-l-4 border-l-teal-500 border-y border-r border-slate-700',
    red: 'border-l-4 border-l-red-500 border-y border-r border-slate-700',
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
