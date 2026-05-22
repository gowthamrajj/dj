import type { TrinoQuerySummary } from '@shared/trino/types';

import { formatBytes, formatMs, formatNumber, stateColor } from '../format';
import { StatCard } from './StatCard';

export type StatsGridProps = { summary: TrinoQuerySummary };

/**
 * 4x2 metric tile grid for the Query Info card. The two
 * coordinator-only fields (`dataSkewScore`, `largestOperator`) render
 * "—" until `trino-fetch-query-info` populates them, so the grid
 * doesn't reflow between summary and full modes.
 */
export function StatsGrid({ summary }: StatsGridProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard label="State">
        <span className={`font-semibold ${stateColor(summary.state)}`}>
          {summary.state}
        </span>
      </StatCard>
      <StatCard label="Wall time">{formatMs(summary.wallTimeMs)}</StatCard>
      <StatCard label="CPU time">{formatMs(summary.cpuTimeMs)}</StatCard>
      <StatCard label="Peak memory">
        {formatBytes(summary.peakUserMemoryBytes)}
      </StatCard>
      <StatCard label="Total splits">
        {formatNumber(summary.totalSplits)}
      </StatCard>
      <StatCard label="Blocked time">
        {formatMs(summary.blockedTimeMs)}
      </StatCard>
      <StatCard label="Data skew score">
        {summary.dataSkewScore !== undefined
          ? summary.dataSkewScore.toFixed(2)
          : '—'}
      </StatCard>
      <StatCard label="Largest operator">
        <span className="font-mono text-xs">
          {summary.largestOperator ?? '—'}
        </span>
      </StatCard>
    </div>
  );
}
