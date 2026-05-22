import { ClipboardIcon } from '@heroicons/react/20/solid';
import type { TrinoQuerySummary } from '@shared/trino/types';
import { Button, Progress } from '@web/elements';

import { ProfileChip } from './ProfileChip';
import { StatsGrid } from './StatsGrid';

export type QueryInfoCardProps = {
  summary: TrinoQuerySummary;
  loadedFromLabel?: string | null;
  profileName?: string;
  coordinatorUrl?: string;
  progressPercent?: number | null;
  progressCaption?: string;
  bannerSlot?: React.ReactNode;
  actions?: React.ReactNode;
};

/**
 * Top "Query Info" card. Identical between summary-only and full-info
 * modes; only the `bannerSlot` and `actions` differ. The header
 * carries the identifying facts (Query ID, snapshot source, profile)
 * so they stay visible regardless of which tab is active below. The
 * DJ model match lives in the Overview tab's Metadata card alongside
 * the rest of the query's identifying fields.
 */
export function QueryInfoCard({
  summary,
  loadedFromLabel,
  profileName,
  coordinatorUrl,
  progressPercent,
  progressCaption,
  bannerSlot,
  actions,
}: QueryInfoCardProps) {
  return (
    <div className="rounded border border-neutral p-3 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <h2 className="text-lg font-semibold m-0">Query Info</h2>
          <div className="flex items-center gap-1 text-xs opacity-70 min-w-0">
            <span>ID:</span>
            <code className="font-mono break-all">{summary.queryId}</code>
            <Button
              variant="iconButton"
              className="!p-1"
              title="Copy Query ID"
              icon={
                <ClipboardIcon className="w-3.5 h-3.5" aria-hidden="true" />
              }
              onClick={() =>
                void navigator.clipboard.writeText(summary.queryId)
              }
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {loadedFromLabel && (
              <span className="text-xs opacity-70">{loadedFromLabel}</span>
            )}
            {profileName && (
              <ProfileChip name={profileName} url={coordinatorUrl} />
            )}
          </div>
        </div>
        {actions && (
          <div className="flex gap-2 flex-wrap shrink-0">{actions}</div>
        )}
      </div>
      {bannerSlot}
      {typeof progressPercent === 'number' && (
        <Progress percent={progressPercent} caption={progressCaption} />
      )}
      <StatsGrid summary={summary} />
    </div>
  );
}
