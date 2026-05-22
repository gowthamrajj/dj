import type { TrinoCoordinatorPing, TrinoProfile } from '@shared/trino/types';
import { Box, Button, SelectSingle, Spinner } from '@web/elements';
import { useMemo } from 'react';

import { useTrinoLive } from './useTrinoLive';

export type ConnectionPanelProps = {
  /** Open the right-pane Manage Profiles view. */
  onManage: () => void;
};

/**
 * Status line under the profile selector. Four modes:
 * - Switching → small spinner + "Switching to <name>…" + new URL.
 * - Pinging → small spinner + coordinator URL.
 * - OK → green dot + URL + (v<version>).
 * - Failed → red dot + URL + "— <error>".
 *
 * The URL is truncated with a native tooltip so long Starburst Galaxy URLs
 * don't blow out the 420px sidebar.
 */
function StatusLine({
  ping,
  profile,
  switching,
}: {
  ping: TrinoCoordinatorPing | null;
  profile: TrinoProfile | null;
  switching: boolean;
}) {
  const url = profile?.coordinatorUrl;
  if (switching) {
    return (
      <div className="flex items-center gap-2 text-xs opacity-80">
        <Spinner size={10} />
        <span className="flex-shrink-0">
          Switching to <strong>{profile?.name ?? '…'}</strong>
        </span>
        {url && (
          <span className="truncate font-mono opacity-70" title={url}>
            {url}
          </span>
        )}
      </div>
    );
  }
  if (ping === null) {
    return (
      <div className="flex items-center gap-2 text-xs opacity-70">
        <Spinner size={10} />
        <span className="truncate" title={url}>
          {url ?? 'Pinging…'}
        </span>
      </div>
    );
  }
  if (ping.ok) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
        <span className="truncate font-mono" title={url}>
          {url ?? '—'}
        </span>
        {ping.version && (
          <span className="opacity-70 flex-shrink-0">(v{ping.version})</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
      <span className="truncate font-mono" title={url}>
        {url ?? 'Disconnected'}
      </span>
      {ping.error && (
        <span className="opacity-70 truncate" title={ping.error}>
          — {ping.error}
        </span>
      )}
    </div>
  );
}

/**
 * Compact connection panel at the top of the master sidebar (above
 * the Live/History tabs). Owns the active-profile select and the
 * "Manage profiles" affordance.
 *
 * Polling, ping state, and profile state all flow through
 * `TrinoLiveContext` so the pill and the Live tab share a single
 * `/v1/query` heartbeat.
 */
export function ConnectionPanel({ onManage }: ConnectionPanelProps) {
  const {
    profiles,
    active,
    activeProfile,
    setActiveProfile,
    switchingProfile,
    ping,
  } = useTrinoLive();

  const profileOptions = useMemo(
    () => profiles.map((p) => ({ value: p.name, label: p.name })),
    [profiles],
  );
  const selectedOption = profileOptions.find((o) => o.value === active) ?? null;

  return (
    <div className="border-b border-neutral bg-background text-background-contrast p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Trino coordinator</div>
        <Button
          variant="secondary"
          label="Manage profiles"
          onClick={onManage}
        />
      </div>

      {profiles.length === 0 ? (
        <Box variant="bordered">
          <div className="text-xs">
            <strong>⚠ No Trino profile configured.</strong>
            <div className="mt-1 opacity-80 leading-relaxed">
              Using the local Trino CLI — limited functionality (no live REST
              listings, no per-query JSON, no Analyze with AI). Click{' '}
              <strong>Manage profiles</strong> to add one.
            </div>
          </div>
        </Box>
      ) : (
        <>
          <SelectSingle
            options={profileOptions}
            value={selectedOption}
            onChange={(o) => {
              if (o) void setActiveProfile(o.value);
            }}
            onBlur={() => {}}
            showClearButton={false}
            placeholder="Pick a profile"
            // Lock the dropdown while a switch is in flight so rapid
            // re-clicks don't race the in-flight RPC.
            disabled={switchingProfile}
          />
          <StatusLine
            ping={ping}
            profile={activeProfile}
            switching={switchingProfile}
          />
        </>
      )}
    </div>
  );
}
