import { sqlFormat, sqlToHtml } from '@shared/sql/utils';
import type {
  DjModelMatch,
  TrinoQueryInfo,
  TrinoQuerySummary,
} from '@shared/trino/types';
import DataSearchIcon from '@web/assets/icons/data-search.svg?react';
import { useApp } from '@web/context';
import {
  Alert,
  Box,
  Button,
  Progress,
  Spinner,
  Tab,
  Text,
} from '@web/elements';
import { useError } from '@web/hooks';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  formatBytes,
  formatDateTime,
  formatMs,
  formatNumber,
  stateColor,
} from './format';
import { OperatorTable } from './OperatorTable';
import { StageTree } from './StageTree';
import type { SelectedQuery } from './types';
import { useTrinoLive } from './useTrinoLive';

export type QueryDetailProps = {
  selected: SelectedQuery | null;
};

/**
 * States in which the coordinator's view of the query can no longer
 * evolve. Used to:
 * - hide the running-progress bar in OverviewTab,
 * - hide "Refresh from coordinator" (refreshing returns identical bytes,
 *   or HTTP 410 if the query has aged out of memory).
 */
const TERMINAL_STATES = new Set(['FINISHED', 'FAILED', 'CANCELED']);

/**
 * HeaderCard works for both the summary-only view (live row clicked but
 * full details not yet fetched) and the full-info view. The two extra
 * fields (`dataSkewScore`, `largestOperator`) only land on `summary`
 * after `trino-fetch-query-info` runs server-side; they show "—" until
 * then.
 */
function HeaderCard({
  summary,
  modelMatch,
}: {
  summary: TrinoQuerySummary;
  modelMatch?: DjModelMatch | null;
}) {
  return (
    <div className="flex flex-col gap-2 mb-3">
      <ModelPill modelMatch={modelMatch} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="State">
          <span className={`font-semibold ${stateColor(summary.state)}`}>
            {summary.state}
          </span>
        </Stat>
        <Stat label="Wall time">{formatMs(summary.wallTimeMs)}</Stat>
        <Stat label="CPU time">{formatMs(summary.cpuTimeMs)}</Stat>
        <Stat label="Peak memory">
          {formatBytes(summary.peakUserMemoryBytes)}
        </Stat>
        <Stat label="Total splits">{formatNumber(summary.totalSplits)}</Stat>
        <Stat label="Blocked time">{formatMs(summary.blockedTimeMs)}</Stat>
        <Stat label="Data skew score">
          {summary.dataSkewScore !== undefined
            ? summary.dataSkewScore.toFixed(2)
            : '—'}
        </Stat>
        <Stat label="Largest operator">
          <span className="font-mono text-xs">
            {summary.largestOperator ?? '—'}
          </span>
        </Stat>
      </div>
    </div>
  );
}

/**
 * Shows which DJ model this query maps to (or that it's unmatched).
 * `comment` matches via dbt's query_comment `node_id`, `fqn` via the
 * `CREATE TABLE catalog.schema.name` wrapper, `cte` via the trailing
 * `SELECT * FROM <name>` in compiled SQL.
 *
 * `modelMatch === undefined` means we haven't fetched full details yet
 * (live summary-only mode) — we show a muted "pending" chip rather than
 * the false-negative "unmatched" chip.
 */
function ModelPill({ modelMatch }: { modelMatch?: DjModelMatch | null }) {
  if (modelMatch === undefined) {
    return (
      <div
        className="inline-flex items-center gap-2 self-start px-2 py-1 rounded border border-neutral bg-surface text-xs opacity-60"
        title="Load full details to resolve the DJ model match. The matcher reads the SQL text and consults the dbt manifest server-side."
      >
        <span className="font-semibold">Model:</span>
        <span>— (load details to resolve)</span>
      </div>
    );
  }
  const m = modelMatch;
  if (!m) {
    return (
      <div
        className="inline-flex items-center gap-2 self-start px-2 py-1 rounded border border-neutral bg-surface text-xs opacity-80"
        title="This Trino query couldn't be linked to a DJ model. The query may be ad-hoc, or dbt's `query-comment` has been disabled in dbt_project.yml. The matcher tries dbt's `node_id` comment, the materialization FQN, and the trailing CTE pattern."
      >
        <span className="font-semibold">Model:</span>
        <span>— (unmatched)</span>
      </div>
    );
  }
  const reason =
    m.matchedBy === 'comment'
      ? 'Matched via dbt query_comment node_id (highest confidence).'
      : m.matchedBy === 'fqn'
        ? 'Matched via the materialization target (CREATE TABLE / INSERT INTO).'
        : 'Matched via the trailing CTE pattern in compiled SQL.';
  return (
    <div
      className="inline-flex items-center gap-2 self-start px-2 py-1 rounded border border-message-info bg-message-info text-xs text-message-info-contrast"
      title={reason}
    >
      <span className="font-semibold">Model:</span>
      <span className="font-mono">
        {m.project}:{m.modelName}
      </span>
      <span className="opacity-70">[{m.matchedBy}]</span>
    </div>
  );
}

function Stat({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="border border-neutral rounded px-2 py-1">
      <div className="text-xs opacity-70">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * Pretty-printed SQL viewer used by both the summary-only Live mode
 * and the post-fetch Overview tab. Pure render — formatting failures
 * fall back to the raw SQL text.
 */
function SqlPreview({ sql }: { sql: string | undefined }) {
  const sqlHtml = useMemo(() => {
    if (!sql) return null;
    try {
      const formatted = sqlFormat(sql);
      return DOMPurify.sanitize(sqlToHtml(formatted));
    } catch {
      return DOMPurify.sanitize(sql);
    }
  }, [sql]);

  if (!sqlHtml) return null;
  return (
    <Box variant="bordered">
      <Text variant="label">Query SQL</Text>
      <div className="mt-2 overflow-auto text-xs font-mono">
        {parse(sqlHtml)}
      </div>
    </Box>
  );
}

function OverviewTab({ info }: { info: TrinoQueryInfo }) {
  const s = info.summary;
  const isTerminal = TERMINAL_STATES.has(s.state);
  const progress = useMemo(() => {
    if (isTerminal) return null;
    if (!s.totalSplits) {
      if (s.state === 'QUEUED') return 10;
      // PLANNING / STARTING — show something before splits exist so the
      // bar doesn't appear completely empty.
      return 25;
    }
    const done = s.completedSplits ?? 0;
    return Math.min(100, 10 + Math.round((90 * done) / s.totalSplits));
  }, [isTerminal, s]);

  return (
    <div className="flex flex-col gap-3">
      {progress !== null ? (
        <Progress
          label="Query progress"
          percent={progress}
          caption={
            s.totalSplits
              ? `${s.completedSplits ?? 0} / ${s.totalSplits} splits`
              : undefined
          }
        />
      ) : (
        // Terminal queries: replace the always-full progress bar with a
        // single muted completion line so the section isn't empty.
        <div className="text-xs opacity-70">
          {s.state === 'FINISHED'
            ? `Completed in ${formatMs(s.wallTimeMs) ?? '—'}`
            : s.state === 'FAILED'
              ? `Failed after ${formatMs(s.wallTimeMs) ?? '—'}`
              : `${s.state.toLowerCase()} after ${formatMs(s.wallTimeMs) ?? '—'}`}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
        <KV k="Query ID" v={s.queryId} mono />
        <KV k="User" v={s.user} />
        <KV k="Source" v={s.source} />
        <KV k="Catalog" v={s.catalog} />
        <KV k="Schema" v={s.schema} />
        <KV k="Created" v={formatDateTime(s.created)} />
        <KV k="Started" v={formatDateTime(s.started)} />
        <KV k="Ended" v={formatDateTime(s.ended)} />
      </div>
      <SqlPreview sql={info.query} />
    </div>
  );
}

function KV({
  k,
  v,
  mono,
}: {
  k: string;
  v: string | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="opacity-70">{k}</span>
      <span className={mono ? 'font-mono text-xs' : ''}>{v ?? '—'}</span>
    </div>
  );
}

function ErrorTab({ info }: { info: TrinoQueryInfo }) {
  if (info.summary.state !== 'FAILED' && !info.failureInfo) {
    return (
      <Alert
        label="No errors"
        description="The query executed successfully."
        variant="success"
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Alert
        label={
          info.summary.errorCode
            ? `${info.summary.errorCode}${
                info.summary.errorType ? ` (${info.summary.errorType})` : ''
              }`
            : 'Query failed'
        }
        description={info.summary.failureMessage}
        variant="error"
      />
      {info.failureInfo && (
        <Box variant="bordered">
          <Text variant="label">failureInfo</Text>
          <pre className="text-xs whitespace-pre-wrap mt-2">
            {JSON.stringify(info.failureInfo, null, 2)}
          </pre>
        </Box>
      )}
    </div>
  );
}

/**
 * Detail pane. Selection sources drive the auto-fetch policy:
 * - `live` — show summary from the row data; wait for an explicit
 *   "Load full details" click before fetching. Zero REST cost for
 *   browsing the Live tab.
 * - `history` — auto-load with `prefer: 'persisted'`. Always reads
 *   from `.dj/diagnostics/<id>.json` (no network).
 * - `preselect` — opened via URL / external command. Auto-load with
 *   `prefer: 'persisted'`; falls through to REST if no local copy.
 */
export function QueryDetail({ selected }: QueryDetailProps) {
  const { api } = useApp();
  const { error, handleError, clearError } = useError();
  // `refreshPersisted` is invoked after any action that writes to
  // .dj/diagnostics/ (REST fetches, Analyze with AI, Refresh from
  // coordinator) so the History tab picks up new diagnostics inline.
  const { refreshPersisted } = useTrinoLive();
  const [info, setInfo] = useState<TrinoQueryInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [lastAnalysis, setLastAnalysis] = useState<{
    jsonPath: string;
    prompt: string;
  } | null>(null);

  const queryId = selected?.queryId ?? null;

  const load = useCallback(
    async (id: string, prefer: 'persisted' | 'rest' = 'persisted') => {
      try {
        setLoading(true);
        clearError();
        const res = await api.post({
          type: 'trino-fetch-query-info',
          request: { queryId: id, prefer },
        });
        setInfo(res);
        // Only refresh the History list when the backend actually wrote
        // a new (or refreshed) sanitized JSON — i.e. on a REST fetch,
        // whether explicit (Refresh from coordinator, Load full details)
        // or implicit (persisted-first fell through to REST because no
        // local copy existed yet). Straight persisted hits skip the
        // refresh: the file isn't touched, so a re-listing would be a
        // wasted round-trip.
        if (res.loadedFrom === 'rest') {
          void refreshPersisted();
        }
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(false);
      }
    },
    [api, handleError, clearError, refreshPersisted],
  );

  // Reset cached info whenever the selection changes. Then auto-load
  // only for `history` / `preselect` — `live` waits for the user.
  useEffect(() => {
    setInfo(null);
    clearError();
    setLastAnalysis(null);
    if (!selected) return;
    if (selected.source === 'history' || selected.source === 'preselect') {
      void load(selected.queryId, 'persisted');
    }
  }, [selected, load, clearError]);

  async function handleAnalyze() {
    if (!queryId) return;
    try {
      setAnalyzing(true);
      const res = await api.post({
        type: 'trino-analyze-query',
        request: { queryId },
      });
      // Copy the ready-to-paste prompt to the clipboard so the user can
      // immediately paste into their AI agent. The dedicated "AI prompt"
      // Box below also surfaces the text visibly with a manual Copy
      // button, in case the clipboard write was blocked or overwritten.
      try {
        await navigator.clipboard.writeText(res.promptSnippet);
      } catch {
        // Clipboard write can fail when the webview is not focused —
        // the prompt Box still shows the text so the user can copy it
        // manually.
      }
      setLastAnalysis({ jsonPath: res.jsonPath, prompt: res.promptSnippet });
      // Reload the persisted-first path so the panel reflects the
      // freshly sanitized snapshot inline. `load(prefer: 'persisted')`
      // can serve from disk without re-persisting, so it won't trigger
      // `refreshPersisted` itself — call it directly because
      // `trino-analyze-query` does write a fresh diagnostic when none
      // existed yet.
      void load(queryId, 'persisted');
      void refreshPersisted();
    } catch (err) {
      handleError(err);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleJumpToModel() {
    if (!queryId) return;
    try {
      await api.post({
        type: 'trino-jump-to-model-from-query',
        request: { queryId },
      });
    } catch (err) {
      handleError(err);
    }
  }

  if (!selected) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="flex items-center gap-8 max-w-2xl">
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold m-0">
              Select a query to view details
            </h2>
            <p className="text-sm opacity-70 m-0">
              Pick a query from Live or History to view its plan, stats, and
              SQL &mdash; or run an AI analysis on it.
            </p>
          </div>
          <DataSearchIcon
            className="w-24 h-24 opacity-30 shrink-0"
            aria-hidden="true"
          />
        </div>
      </div>
    );
  }

  // Live row clicked, but full details haven't been fetched yet.
  // Render the headline + identification + SQL from the row summary
  // (all free, no REST call) and a single primary action ("Load full
  // details") to fetch the plan / operator table / dataSkew /
  // largestOperator from the coordinator.
  if (selected.source === 'live' && !info && !loading) {
    const s = selected.summary;
    return (
      <div className="p-3 flex flex-col gap-3 h-full min-h-0">
        {s ? (
          <HeaderCard summary={s} />
        ) : (
          <Box variant="bordered">
            <Text>No summary cached for {selected.queryId}.</Text>
          </Box>
        )}
        {error ? (
          <Alert
            label="Failed to fetch query info"
            description={error.message}
            variant="error"
          />
        ) : null}
        <Box variant="bordered">
          <Text>
            This is a preview of the selected query. Click{' '}
            <strong>Load full details</strong> to fetch the execution plan,
            operator table, and data-skew score from the coordinator.
          </Text>
        </Box>
        {/* Action-row variants: `primary` for the lead, `outlineIconButton`
            for supporting actions. Both render at the same height (~36 px);
            `secondary` would render shorter and break the row's baseline. */}
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="primary"
            label="Load full details"
            onClick={() => void load(selected.queryId, 'rest')}
          />
          <Button
            variant="outlineIconButton"
            className="text-sm"
            label="Analyze with AI"
            loading={analyzing}
            onClick={() => void handleAnalyze()}
          />
          <Button
            variant="outlineIconButton"
            className="text-sm"
            label="Copy Query ID"
            onClick={() => void navigator.clipboard.writeText(selected.queryId)}
          />
        </div>
        {s && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
            <KV k="Query ID" v={s.queryId} mono />
            <KV k="User" v={s.user} />
            <KV k="Source" v={s.source} />
            <KV k="Catalog" v={s.catalog} />
            <KV k="Schema" v={s.schema} />
            <KV k="Created" v={formatDateTime(s.created)} />
            <KV k="Started" v={formatDateTime(s.started)} />
            <KV k="Ended" v={formatDateTime(s.ended)} />
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto">
          <SqlPreview sql={s?.query} />
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <Box variant="padded">
        <Spinner />
        <Text>Loading query info…</Text>
      </Box>
    );
  }
  if (error) {
    return (
      <Box variant="padded">
        <Alert
          label="Failed to fetch query info"
          description={error.message}
          variant="error"
        />
      </Box>
    );
  }
  if (!info) {
    return (
      <Box variant="padded">
        <Text>No data for {selected.queryId}.</Text>
      </Box>
    );
  }

  const loadedFromLabel =
    info.loadedFrom === 'persisted'
      ? 'Loaded from .dj/diagnostics (may be stale)'
      : info.loadedFrom === 'rest'
        ? 'Loaded from coordinator'
        : null;
  const profileTooltip = info.coordinatorUrl
    ? `Captured from profile "${info.profileName}" (${info.coordinatorUrl})`
    : info.profileName
      ? `Captured from profile "${info.profileName}"`
      : undefined;
  // Only show "Refresh from coordinator" when the coordinator state could
  // still evolve. Terminal queries (FINISHED / FAILED / CANCELED) are
  // immutable at the coordinator; refreshing them returns the same bytes
  // or HTTP 410 if the query has aged out of memory. History items already
  // have loadedFrom === 'persisted' so they're filtered separately.
  const showRefresh =
    info.loadedFrom === 'rest' && !TERMINAL_STATES.has(info.summary.state);

  return (
    <div className="p-3 flex flex-col gap-3 h-full min-h-0">
      <HeaderCard summary={info.summary} modelMatch={info.modelMatch} />
      {(loadedFromLabel || info.profileName) && (
        <div className="flex items-center gap-2 -mt-2 text-xs opacity-70 flex-wrap">
          {loadedFromLabel && <span>{loadedFromLabel}</span>}
          {info.profileName && (
            <span
              className="px-1.5 py-0.5 rounded border border-neutral"
              title={profileTooltip}
            >
              {info.profileName}
              {info.coordinatorUrl && (
                <span className="ml-1 opacity-70 truncate">
                  · {info.coordinatorUrl}
                </span>
              )}
            </span>
          )}
        </div>
      )}
      {/* Action-row variants: `primary` for the lead, `outlineIconButton`
          for supporting actions so heights match (~36 px). `secondary`
          would render shorter and break the row's baseline. */}
      <div className="flex gap-2 flex-wrap">
        <Button
          variant="primary"
          label="Analyze with AI"
          loading={analyzing}
          onClick={() => void handleAnalyze()}
        />
        <span
          title={
            info.modelMatch
              ? `Open ${info.modelMatch.project}:${info.modelMatch.modelName}`
              : "No DJ model linked. The matcher couldn't resolve this query via dbt's query_comment, materialization FQN, or trailing CTE pattern."
          }
        >
          <Button
            variant="outlineIconButton"
            className="text-sm"
            label="Jump to Model"
            disabled={!info.modelMatch}
            onClick={() => void handleJumpToModel()}
          />
        </span>
        {showRefresh && (
          <Button
            variant="outlineIconButton"
            className="text-sm"
            label="Refresh from coordinator"
            onClick={() => void load(selected.queryId, 'rest')}
          />
        )}
        <Button
          variant="outlineIconButton"
          className="text-sm"
          label="Copy Query ID"
          onClick={() => void navigator.clipboard.writeText(selected.queryId)}
        />
      </div>
      {info.jsonPath && (
        <Box variant="bordered">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col min-w-0 flex-1">
              <Text variant="label">Sanitized JSON file</Text>
              <code className="text-xs mt-1 break-all opacity-80">
                {info.jsonPath}
              </code>
            </div>
            <Button
              variant="secondary"
              label="Copy path"
              title="Copy the absolute path to the clipboard"
              onClick={() =>
                void navigator.clipboard.writeText(info.jsonPath ?? '')
              }
            />
          </div>
          <div className="text-xs opacity-70 mt-2">
            This is the sanitized Trino QueryInfo your AI agent will read. Click{' '}
            <strong>Analyze with AI</strong> to also generate a ready-to-paste
            prompt.
          </div>
        </Box>
      )}
      {lastAnalysis && (
        <Box variant="bordered">
          <div className="flex items-start justify-between gap-2">
            <Text variant="label">AI prompt (copied to clipboard)</Text>
            <Button
              variant="secondary"
              label="Copy prompt"
              title="Copy the prompt to the clipboard again"
              onClick={() =>
                void navigator.clipboard.writeText(lastAnalysis.prompt)
              }
            />
          </div>
          <pre className="text-xs mt-2 whitespace-pre-wrap opacity-90">
            {lastAnalysis.prompt}
          </pre>
          <div className="text-xs opacity-70 mt-2">
            Paste this prompt into your AI agent (Cursor, Claude Code, GitHub
            Copilot Chat) with the <code>dj-trino-analyzer</code> skill loaded.
          </div>
        </Box>
      )}
      <div className="flex-1 min-h-0">
        <Tab
          tabs={['Overview', 'Stages', 'Operators', 'Errors']}
          panels={[
            <OverviewTab key="overview" info={info} />,
            <StageTree key="stages" stage={info.rootStage} />,
            <OperatorTable key="ops" operators={info.operatorSummary ?? []} />,
            <ErrorTab key="errors" info={info} />,
          ]}
        />
      </div>
    </div>
  );
}
