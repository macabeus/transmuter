import React, { useMemo, useState } from 'react';

import { RefinementApp } from './RefinementApp';
import { CandidateGraph } from './components/CandidateGraph';
import { CodeBlock } from './components/CodeBlock';
import { FocusResults } from './components/FocusResults';
import { Header } from './components/Header';
import { Icon, type IconName } from './components/Icon';
import { RuleEffectiveness } from './components/RuleEffectiveness';
import { ScoreTimeline } from './components/ScoreTimeline';
import { SessionSummaryView } from './components/SessionSummary';
import type { RefinementReport, Report, SessionReport } from './types';

type Tab = 'overview' | 'graph' | 'rules' | 'focus';

function isRefinement(report: Report): report is RefinementReport {
  return report.type === 'refinement';
}

export function App(): React.ReactElement {
  const report = useMemo(() => window.__SESSION_REPORT__ ?? null, []);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  if (!report) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-slate-400">No session report data found.</p>
      </div>
    );
  }

  if (isRefinement(report)) {
    return <RefinementApp report={report} />;
  }

  const candidateCount = report.graph.candidates.length;

  const tabs: { id: Tab; label: string; icon: IconName; show: boolean }[] = [
    { id: 'overview', label: 'Overview', icon: 'document', show: true },
    { id: 'graph', label: `Graph (${candidateCount})`, icon: 'gitBranch', show: candidateCount > 0 },
    { id: 'rules', label: 'Rules', icon: 'rules', show: report.ruleStats.length > 0 },
    { id: 'focus', label: 'Focus', icon: 'target', show: report.focusResults.length > 0 },
  ];

  return (
    <div className="min-h-screen">
      <div className="max-w-[1600px] mx-auto px-4 py-8">
        <Header subtitle="Session Report" rightContent={<SessionHeaderStats report={report} />} />

        <div className="flex items-center gap-2 mb-6 overflow-x-auto">
          {tabs
            .filter((t) => t.show)
            .map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-teal-500/20 to-emerald-500/10 text-teal-300 border border-teal-500/30 shadow-lg shadow-teal-500/10'
                      : 'text-slate-400 border border-transparent hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <Icon name={tab.icon} className={`w-4 h-4 ${isActive ? 'text-teal-400' : 'text-slate-500'}`} />
                  {tab.label}
                </button>
              );
            })}
        </div>

        <main>
          <TabContent tab={activeTab} report={report} />
        </main>
      </div>
    </div>
  );
}

function SessionHeaderStats({ report }: { report: SessionReport }): React.ReactElement {
  const { summary, config, metadata } = report;
  const isPerfect = summary.perfectMatch;

  return (
    <div className="flex items-center gap-4 justify-end">
      <div className="flex flex-col items-end">
        <p className="text-white text-lg font-bold font-mono tracking-tight">{config.functionName}</p>
        <div className="flex items-center gap-2 mt-0.5 text-sm">
          <ScoreBadge base={summary.baseScore} best={summary.bestScore} perfect={isPerfect} />
          {config.profile && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700/80 text-slate-300 border border-slate-600">
              {config.profile}
            </span>
          )}
          {metadata.partial && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
              in progress
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ScoreBadge({ base, best, perfect }: { base: number; best: number; perfect: boolean }): React.ReactElement {
  const color = perfect ? 'text-emerald-400' : best < base ? 'text-amber-300' : 'text-slate-300';
  return (
    <div className="flex items-center gap-1.5 font-mono">
      <span className="text-slate-400">{base}</span>
      <span className="text-slate-600">→</span>
      <span className={`font-bold ${color}`}>{best}</span>
      {perfect && <span className="text-emerald-400">✓</span>}
    </div>
  );
}

function ContextSourceView({
  source,
  language,
}: {
  source: string;
  language: 'c' | 'cpp' | 'pascal';
}): React.ReactElement {
  return (
    <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Context source</h3>
        <span className="text-[10px] text-slate-500">
          {source.length.toLocaleString()} bytes — pre-isolation, shared across all candidates
        </span>
      </div>
      <CodeBlock code={source} language={language} />
    </div>
  );
}

function TabContent({ tab, report }: { tab: Tab; report: SessionReport }): React.ReactElement {
  switch (tab) {
    case 'overview':
      return (
        <div className="space-y-6">
          <SessionSummaryView summary={report.summary} config={report.config} metadata={report.metadata} />
          {report.scoreTimeline.length > 1 && <ScoreTimeline timeline={report.scoreTimeline} />}
          {report.contextSource !== undefined && (
            <ContextSourceView source={report.contextSource} language={report.config.language ?? 'c'} />
          )}
        </div>
      );
    case 'graph':
      return (
        <CandidateGraph
          candidates={report.graph.candidates}
          mutationTargets={report.graph.mutationTargets}
          superNodes={report.graph.superNodes}
          sourceLanguage={report.config.language}
          cleanup={report.cleanup}
        />
      );
    case 'rules':
      return <RuleEffectiveness stats={report.ruleStats} />;
    case 'focus':
      return <FocusResults results={report.focusResults} />;
  }
}
