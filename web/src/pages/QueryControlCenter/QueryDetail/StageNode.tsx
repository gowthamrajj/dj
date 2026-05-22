import type { TrinoStage } from '@shared/trino/types';
import { Button } from '@web/elements';
import { useState } from 'react';

import { formatBytes, formatMs, formatNumber } from '../format';

type Picked = {
  totalCpuTimeMs?: number;
  totalScheduledTimeMs?: number;
  totalBlockedTimeMs?: number;
  peakMemoryBytes?: number | string;
  totalDrivers?: number;
  processedRows?: number;
  processedBytes?: number | string;
};

/**
 * Normalises the heterogeneous `stageStats` Trino sends back into a
 * small predictable shape for the row UI. Trino reports time fields
 * as either `*Time` (Duration string like `"1.23s"`) or `*TimeMillis`
 * (raw ms number) depending on coordinator version — we prefer the
 * numeric variant when present and fall through to the string for
 * display. Byte fields are intentionally left as `number | string`
 * because Trino frequently returns human-readable sizes.
 */
function pickStageStats(stats: Record<string, unknown> | undefined): Picked {
  if (!stats) return {};
  const get = (key: string): unknown => stats[key];
  const asNumber = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isNaN(n) ? undefined : n;
  };
  const cpu = get('totalCpuTime');
  const blocked = get('totalBlockedTime');
  const sched = get('totalScheduledTime');
  return {
    totalCpuTimeMs:
      typeof cpu === 'number' ? cpu : asNumber(get('totalCpuTimeMillis')),
    totalScheduledTimeMs:
      typeof sched === 'number'
        ? sched
        : asNumber(get('totalScheduledTimeMillis')),
    totalBlockedTimeMs:
      typeof blocked === 'number'
        ? blocked
        : asNumber(get('totalBlockedTimeMillis')),
    peakMemoryBytes: get('peakMemoryReservation') as
      | number
      | string
      | undefined,
    totalDrivers: asNumber(get('totalDrivers')),
    processedRows: asNumber(get('rawInputPositions')),
    processedBytes: get('rawInputDataSize') as number | string | undefined,
  };
}

export type StageNodeProps = {
  stage: TrinoStage;
  depth: number;
};

/**
 * Recursive stage tree row. Renders a single stage's stats inline,
 * with a collapsible toggle when there are sub-stages. Self-recursive
 * — TypeScript/ESM handles same-file recursion without trouble.
 */
export function StageNode({ stage, depth }: StageNodeProps) {
  const [open, setOpen] = useState(true);
  const stats = pickStageStats(stage.stageStats);
  const subStages = stage.subStages ?? [];

  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <div className="flex items-center gap-2 py-1">
        {subStages.length > 0 ? (
          // `Button variant="link"` with an explicit className skips the
          // default `px-4 py-2`, giving us the tight 4-glyph toggle the
          // tree row needs while still routing through the design-system
          // Button primitive (Headless wrapper, focus ring, disabled).
          <Button
            variant="link"
            onClick={() => setOpen((o) => !o)}
            className="text-xs w-4"
            aria-label={open ? 'Collapse stage' : 'Expand stage'}
            label={open ? '▾' : '▸'}
          />
        ) : (
          <span className="w-4" />
        )}
        <span className="font-mono text-xs">Stage {stage.stageId ?? '?'}</span>
        <span className="text-xs opacity-70">{stage.state ?? ''}</span>
        <span className="text-xs opacity-70">
          {formatNumber(stats.totalDrivers)} drivers
        </span>
        <span className="text-xs opacity-70">
          CPU {formatMs(stats.totalCpuTimeMs)}
        </span>
        <span className="text-xs opacity-70">
          mem {formatBytes(stats.peakMemoryBytes)}
        </span>
        <span className="text-xs opacity-70">
          {formatNumber(stats.processedRows)} rows /{' '}
          {formatBytes(stats.processedBytes)}
        </span>
      </div>
      {open &&
        subStages.map((sub, idx) => (
          <StageNode
            key={sub.stageId ?? `${depth}-${idx}`}
            stage={sub}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}
