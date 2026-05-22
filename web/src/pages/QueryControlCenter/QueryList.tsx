import { TrashIcon } from '@heroicons/react/20/solid';
import type { TrinoQuerySummary } from '@shared/trino/types';
import {
  Box,
  Button,
  Checkbox,
  DialogBox,
  Spinner,
  Tab,
  Text,
} from '@web/elements';
import { useCallback, useMemo, useState } from 'react';

import { formatBytes, formatMs, relativeAge, stateColor } from './format';
import { QueryFilterBar } from './QueryFilterBar';
import {
  buildSingleSelectOptions,
  type StateChip,
  stateKeyFor,
} from './queryFilters';
import type { SelectedQuery } from './types';
import { useTrinoLive } from './useTrinoLive';

export type QueryListProps = {
  selectedQueryId: string | null;
  /**
   * Called when the user clicks a row. The parent uses the `source` tag
   * to decide whether the detail pane should auto-fetch (history /
   * preselect) or wait for an explicit "Load full details" click (live).
   */
  onSelectQuery: (selection: SelectedQuery) => void;
};

function QueryRow({
  query,
  selected,
  onSelect,
  onDelete,
  profileBadge,
}: {
  query: TrinoQuerySummary;
  selected: boolean;
  onSelect: (id: string) => void;
  /** When set, a trash affordance is rendered (history rows only). */
  onDelete?: (id: string) => void;
  /**
   * History-only pill showing which profile wrote the diagnostic JSON.
   * `null` for live rows and for diagnostics whose JSON does not
   * record a profile.
   */
  profileBadge?: { profileName: string; coordinatorUrl?: string } | null;
}) {
  const progress =
    query.totalSplits && query.completedSplits !== undefined
      ? Math.round(
          (100 * query.completedSplits) / Math.max(query.totalSplits, 1),
        )
      : null;
  // Layout note: two sibling buttons inside a wrapper instead of a
  // nested <button> inside a <button>. HTML5 forbids nested interactive
  // content and browsers silently drop the inner click when it happens,
  // so the trash needs its own real <button> next to the row body.
  //
  // The row body itself is kept as a native <button>. The design-system
  // <Button> variants (primary / secondary / iconButton / link / …) all
  // bake in centered text, padding, rounded corners and a specific color
  // scheme that don't fit a list row with custom internal layout — the
  // same reason FileTree.tsx in `web/src/elements/` uses native <button>
  // for its clickable row. The trash sibling (below) goes through the
  // design-system <Button variant="iconButton">.
  return (
    <div
      className={`flex items-stretch border-b border-neutral hover:bg-list-item-hover ${
        selected ? 'bg-message-info border-l-4 border-l-message-info' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(query.queryId)}
        className="text-left flex-1 min-w-0 px-3 py-2"
      >
        <div className="flex justify-between items-baseline gap-2">
          <span className="font-mono text-xs truncate" title={query.queryId}>
            {query.queryId}
          </span>
          <div className="flex items-baseline gap-1.5 flex-shrink-0">
            {profileBadge && (
              <span
                className="text-xs px-1.5 py-0.5 rounded border border-neutral opacity-80"
                title={
                  profileBadge.coordinatorUrl
                    ? `Diagnostic captured from profile "${profileBadge.profileName}" (${profileBadge.coordinatorUrl})`
                    : `Diagnostic captured from profile "${profileBadge.profileName}"`
                }
              >
                {profileBadge.profileName}
              </span>
            )}
            <span
              className={`text-xs font-semibold ${stateColor(query.state)}`}
            >
              {query.state}
            </span>
          </div>
        </div>
        <div className="text-xs opacity-70 flex gap-3 mt-1">
          <span>{relativeAge(query.created ?? query.started)}</span>
          {query.source ? (
            <span className="truncate" title={query.source}>
              {query.source}
            </span>
          ) : null}
          {query.wallTimeMs !== undefined ? (
            <span>{formatMs(query.wallTimeMs)}</span>
          ) : null}
          {query.peakUserMemoryBytes !== undefined ? (
            <span>{formatBytes(query.peakUserMemoryBytes)}</span>
          ) : null}
          {progress !== null ? <span>{progress}%</span> : null}
        </div>
      </button>
      {onDelete && (
        <Button
          variant="iconButton"
          icon={<TrashIcon className="w-4 h-4" />}
          aria-label="Delete from history"
          title="Delete from history"
          onClick={() => onDelete(query.queryId)}
          className="flex-shrink-0 hover:text-error"
        />
      )}
    </div>
  );
}

type LiveListingControlsProps = {
  autoRefresh: boolean;
  onAutoRefreshChange: (next: boolean) => void;
  refreshing: boolean;
  onRefresh: () => void;
  pollIntervalMs: number;
};

/**
 * Compact control strip above the Live query list — auto-refresh
 * toggle (interval inlined into its label) and a manual Refresh
 * button. The active profile and REST/CLI source live in the sidebar
 * ConnectionPanel, so this row stays controls-only.
 */
function LiveListingControls({
  autoRefresh,
  onAutoRefreshChange,
  refreshing,
  onRefresh,
  pollIntervalMs,
}: LiveListingControlsProps) {
  const pollSeconds = Math.round(pollIntervalMs / 1000);
  return (
    <div className="px-3 py-1 text-xs opacity-80 border-b border-neutral flex items-center justify-end gap-3 whitespace-nowrap">
      <Checkbox
        // Inline the cadence into the checkbox label so it stays on one
        // line at sidebar widths and we don't need a separate redundant
        // hint span next to the Refresh button. Tooltip carries the long
        // explanation.
        label={autoRefresh ? `Auto-refresh (${pollSeconds}s)` : 'Auto-refresh'}
        title={
          autoRefresh
            ? `Polling every ${pollSeconds}s.`
            : 'Polling paused. Click Refresh to reload.'
        }
        checked={autoRefresh}
        onChange={(checked) =>
          onAutoRefreshChange(
            typeof checked === 'boolean' ? checked : checked.target.checked,
          )
        }
      />
      <Button
        variant="iconButton"
        icon={
          <span
            aria-hidden
            className={`inline-block ${refreshing ? 'animate-spin' : ''}`}
          >
            ↻
          </span>
        }
        label="Refresh"
        disabled={refreshing}
        title={refreshing ? 'Refreshing…' : 'Refresh now'}
        onClick={onRefresh}
      />
    </div>
  );
}

function LiveTab({ selectedQueryId, onSelectQuery }: QueryListProps) {
  // Pure consumer of the shared TrinoLiveContext — no setInterval /
  // fetch / error state of its own. The connection pill
  // (ConnectionPanel) reads the same context so the two surfaces stay
  // on a single source of truth.
  const {
    rows: queries,
    loading,
    refreshing,
    error,
    autoRefresh,
    setAutoRefresh,
    dbtOnly,
    setDbtOnly,
    refresh,
    responseSource,
    pollIntervalMs,
  } = useTrinoLive();
  const [search, setSearch] = useState('');
  const [selectedStates, setSelectedStates] = useState<Set<StateChip>>(
    () => new Set(),
  );
  const [userFilter, setUserFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');

  const distinctUsers = useMemo(() => {
    const set = new Set<string>();
    queries.forEach((q) => {
      if (q.user) {
        set.add(q.user);
      }
    });
    return Array.from(set).sort();
  }, [queries]);

  const distinctSources = useMemo(() => {
    const set = new Set<string>();
    queries.forEach((q) => {
      if (q.source) {
        set.add(q.source);
      }
    });
    return Array.from(set).sort();
  }, [queries]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return queries.filter((q) => {
      if (
        selectedStates.size > 0 &&
        !selectedStates.has(stateKeyFor(q.state))
      ) {
        return false;
      }
      if (userFilter && q.user !== userFilter) {
        return false;
      }
      if (sourceFilter && q.source !== sourceFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return [q.queryId, q.user, q.source, q.state, q.query]
        .filter(Boolean)
        .some((v) => v!.toString().toLowerCase().includes(needle));
    });
  }, [queries, search, selectedStates, userFilter, sourceFilter]);

  const toggleState = (state: StateChip) => {
    setSelectedStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) {
        next.delete(state);
      } else {
        next.add(state);
      }
      return next;
    });
  };

  const activeFilterCount =
    selectedStates.size +
    (userFilter ? 1 : 0) +
    (sourceFilter ? 1 : 0) +
    (search.trim() ? 1 : 0);

  const clearAllFilters = () => {
    setSelectedStates(new Set());
    setUserFilter('');
    setSourceFilter('');
    setSearch('');
  };

  const userOptions = useMemo(
    () => buildSingleSelectOptions(distinctUsers, userFilter),
    [distinctUsers, userFilter],
  );
  const sourceOptions = useMemo(
    () => buildSingleSelectOptions(distinctSources, sourceFilter),
    [distinctSources, sourceFilter],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <QueryFilterBar
        search={search}
        onSearchChange={setSearch}
        selectedStates={selectedStates}
        onToggleState={toggleState}
        userFilter={userFilter}
        userOptions={userOptions}
        onUserFilterChange={setUserFilter}
        sourceFilter={sourceFilter}
        sourceOptions={sourceOptions}
        onSourceFilterChange={setSourceFilter}
        activeFilterCount={activeFilterCount}
        onClearAll={clearAllFilters}
        dbtOnly={dbtOnly}
        onDbtOnlyChange={setDbtOnly}
      />
      {responseSource !== null && (
        <LiveListingControls
          autoRefresh={autoRefresh}
          onAutoRefreshChange={setAutoRefresh}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          pollIntervalMs={pollIntervalMs}
        />
      )}
      <div className="flex-1 overflow-auto min-h-0">
        {loading ? (
          <Box variant="padded">
            <Spinner />
          </Box>
        ) : error ? (
          <Box variant="padded">
            <Text>Failed to load active queries: {error.message}</Text>
          </Box>
        ) : visible.length === 0 ? (
          <Box variant="padded">
            <div className="text-sm font-semibold">
              No queries match the current filter.
            </div>
            <div className="text-xs opacity-70 mt-2 leading-relaxed">
              The Trino coordinator only keeps recent queries in memory
              (typically the last ~100 queries or the last ~15 minutes,
              whichever comes first). Past queries you&apos;ve clicked
              &ldquo;Analyze with AI&rdquo; on are saved to{' '}
              <code>.dj/diagnostics/</code> and show up under the{' '}
              <strong>History</strong> tab.
            </div>
          </Box>
        ) : (
          visible.map((q) => (
            <QueryRow
              key={q.queryId}
              query={q}
              selected={selectedQueryId === q.queryId}
              onSelect={() =>
                onSelectQuery({
                  queryId: q.queryId,
                  summary: q,
                  source: 'live',
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Sentinel option value for the "no profile recorded" bucket. */
const LEGACY_PROFILE_VALUE = '__legacy__';

function PersistedTab({ selectedQueryId, onSelectQuery }: QueryListProps) {
  // History list + delete come from the shared TrinoLiveContext so
  // deletes stay consistent across consumers and PersistedTab carries
  // no fetch / interval / confirm-dialog state of its own.
  const {
    persistedQueries: items,
    persistedLoading: loading,
    persistedError: error,
    deletePersistedQuery,
  } = useTrinoLive();

  // Local UI state — filters + the pending-delete confirmation target.
  // Filters mirror the Live tab's set (search + state chips + user
  // + source) plus a History-only Profile dropdown sourced from the
  // diagnostics' captured `profileName`.
  const [search, setSearch] = useState('');
  const [selectedStates, setSelectedStates] = useState<Set<StateChip>>(
    () => new Set(),
  );
  const [userFilter, setUserFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<Error | null>(null);

  const distinctUsers = useMemo(() => {
    const set = new Set<string>();
    items.forEach((p) => {
      if (p.summary.user) {
        set.add(p.summary.user);
      }
    });
    return Array.from(set).sort();
  }, [items]);

  const distinctSources = useMemo(() => {
    const set = new Set<string>();
    items.forEach((p) => {
      if (p.summary.source) {
        set.add(p.summary.source);
      }
    });
    return Array.from(set).sort();
  }, [items]);

  // Each profile that ever wrote a diagnostic shows up as a filter
  // option; legacy entries (no `profileName` recorded) bucket under
  // the sentinel so users can still pin to them explicitly.
  const distinctProfiles = useMemo(() => {
    const set = new Set<string>();
    items.forEach((p) => {
      if (p.profileName) {
        set.add(p.profileName);
      }
    });
    return Array.from(set).sort();
  }, [items]);
  const hasLegacy = useMemo(() => items.some((p) => !p.profileName), [items]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((p) => {
      const q = p.summary;
      if (
        selectedStates.size > 0 &&
        !selectedStates.has(stateKeyFor(q.state))
      ) {
        return false;
      }
      if (userFilter && q.user !== userFilter) {
        return false;
      }
      if (sourceFilter && q.source !== sourceFilter) {
        return false;
      }
      if (profileFilter) {
        if (profileFilter === LEGACY_PROFILE_VALUE) {
          if (p.profileName) {
            return false;
          }
        } else if (p.profileName !== profileFilter) {
          return false;
        }
      }
      if (!needle) {
        return true;
      }
      return [q.queryId, q.user, q.source, q.state, q.query, p.profileName]
        .filter(Boolean)
        .some((v) => v!.toString().toLowerCase().includes(needle));
    });
  }, [items, search, selectedStates, userFilter, sourceFilter, profileFilter]);

  const toggleState = useCallback((state: StateChip) => {
    setSelectedStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) {
        next.delete(state);
      } else {
        next.add(state);
      }
      return next;
    });
  }, []);

  const activeFilterCount =
    selectedStates.size +
    (userFilter ? 1 : 0) +
    (sourceFilter ? 1 : 0) +
    (profileFilter ? 1 : 0) +
    (search.trim() ? 1 : 0);

  const clearAllFilters = useCallback(() => {
    setSelectedStates(new Set());
    setUserFilter('');
    setSourceFilter('');
    setProfileFilter('');
    setSearch('');
  }, []);

  const userOptions = useMemo(
    () => buildSingleSelectOptions(distinctUsers, userFilter),
    [distinctUsers, userFilter],
  );
  const sourceOptions = useMemo(
    () => buildSingleSelectOptions(distinctSources, sourceFilter),
    [distinctSources, sourceFilter],
  );
  const profileOptions = useMemo(() => {
    const opts = [
      { value: '', label: 'All' },
      ...distinctProfiles.map((p) => ({ value: p, label: p })),
    ];
    if (hasLegacy) {
      opts.push({ value: LEGACY_PROFILE_VALUE, label: '(none)' });
    }
    if (
      profileFilter &&
      profileFilter !== LEGACY_PROFILE_VALUE &&
      !distinctProfiles.includes(profileFilter)
    ) {
      opts.push({
        value: profileFilter,
        label: `${profileFilter} (not in results)`,
      });
    }
    return opts;
  }, [distinctProfiles, hasLegacy, profileFilter]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return;
    }
    const id = pendingDelete;
    try {
      await deletePersistedQuery(id);
      setPendingDelete(null);
      setDeleteError(null);
      if (selectedQueryId === id) {
        // Empty queryId is the "clear selection" sentinel honored by
        // QueryControlCenter/index.tsx -> handleSelectQuery, so the
        // right pane resets to its empty state.
        onSelectQuery({ queryId: '', summary: null, source: 'history' });
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [deletePersistedQuery, onSelectQuery, pendingDelete, selectedQueryId]);

  if (loading) {
    return (
      <Box variant="padded">
        <Spinner />
      </Box>
    );
  }
  if (error) {
    return (
      <Box variant="padded">
        <Text>Failed to load persisted queries: {error.message}</Text>
      </Box>
    );
  }
  if (items.length === 0) {
    return (
      <Box variant="padded">
        <div className="text-sm font-semibold">No analyzed queries yet.</div>
        <div className="text-xs opacity-70 mt-2 leading-relaxed">
          Click &ldquo;Analyze with AI&rdquo; on a live or finished query — its
          sanitized diagnostic JSON lands in <code>.dj/diagnostics/</code> and
          shows up here even after the coordinator forgets the query.
        </div>
      </Box>
    );
  }

  // The outer Tab panel is `h-full min-h-0` but not a flex column, so
  // the list needs its own `flex flex-col h-full min-h-0` wrapper to
  // give the inner `flex-1 overflow-auto` something to constrain.
  // Without this wrapper the page itself scrolls instead of the list.
  return (
    <div className="flex flex-col h-full min-h-0">
      <QueryFilterBar
        search={search}
        onSearchChange={setSearch}
        selectedStates={selectedStates}
        onToggleState={toggleState}
        userFilter={userFilter}
        userOptions={userOptions}
        onUserFilterChange={setUserFilter}
        sourceFilter={sourceFilter}
        sourceOptions={sourceOptions}
        onSourceFilterChange={setSourceFilter}
        activeFilterCount={activeFilterCount}
        onClearAll={clearAllFilters}
        profileFilter={profileFilter}
        profileOptions={profileOptions}
        onProfileFilterChange={setProfileFilter}
      />
      <div className="flex-1 overflow-auto min-h-0">
        {visible.length === 0 ? (
          <Box variant="padded">
            <div className="text-sm font-semibold">
              No analyzed queries match the current filter.
            </div>
            <div className="text-xs opacity-70 mt-2">
              Adjust the filters above or click <strong>Clear</strong> to see
              every diagnostic in <code>.dj/diagnostics/</code>.
            </div>
          </Box>
        ) : (
          visible.map((item) => (
            <QueryRow
              key={item.queryId}
              query={item.summary}
              selected={selectedQueryId === item.queryId}
              onSelect={() =>
                onSelectQuery({
                  queryId: item.queryId,
                  summary: item.summary,
                  source: 'history',
                })
              }
              onDelete={(id) => setPendingDelete(id)}
              profileBadge={
                item.profileName
                  ? {
                      profileName: item.profileName,
                      coordinatorUrl: item.coordinatorUrl,
                    }
                  : null
              }
            />
          ))
        )}
      </div>
      {deleteError && (
        <Box variant="padded">
          <Text>Failed to delete: {deleteError.message}</Text>
        </Box>
      )}
      <DialogBox
        open={pendingDelete !== null}
        variant="warning"
        title="Remove from history?"
        description={
          pendingDelete
            ? `This deletes the sanitized JSON for ${pendingDelete} from .dj/diagnostics/. The coordinator copy (if it still exists) is not affected.`
            : undefined
        }
        confirmCTALabel="Delete"
        discardCTALabel="Cancel"
        onConfirm={() => void confirmDelete()}
        onDiscard={() => setPendingDelete(null)}
      />
    </div>
  );
}

export function QueryList(props: QueryListProps) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <Tab
        tabs={['Live', 'History']}
        panels={[
          <LiveTab key="live" {...props} />,
          <PersistedTab key="history" {...props} />,
        ]}
      />
    </div>
  );
}
