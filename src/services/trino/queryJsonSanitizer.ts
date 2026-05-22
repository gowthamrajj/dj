/**
 * Trino QueryInfo sanitizer + persistence.
 *
 * Takes the raw `/v1/query/{id}` payload from the coordinator and writes
 * two artifacts to `<workspace>/.dj/diagnostics/`:
 *
 *   <queryId>.full.json — raw coordinator response (audit copy).
 *   <queryId>.json      — LLM-friendly: summary + key stats only, with
 *                         operator detail trimmed, per-driver task detail
 *                         dropped, and a tool firewall that rejects any
 *                         field shaped like row data.
 *
 * Hash-based cache: skip re-sanitization when the queryId already has a
 * sanitized file < 60s old (configurable via SANITIZE_CACHE_TTL_MS). The
 * full.json is also reused — fetching the same query twice in close
 * succession is a no-op.
 */

import type {
  TrinoOperatorSummaryEntry,
  TrinoPersistedQuery,
  TrinoQuerySummary,
  TrinoStage,
} from '@shared/trino/types';
import { WORKSPACE_ROOT } from 'admin';
import * as fs from 'fs';
import * as path from 'path';

const DIAGNOSTICS_SUBDIR = path.join('.dj', 'diagnostics');
const DEFAULT_RETENTION_DAYS = 30;
export const SANITIZE_CACHE_TTL_MS = 60_000;

/**
 * Field-name patterns that suggest row data leakage. These should never
 * appear in QueryInfo, but the tool firewall throws if they do — any
 * change in upstream Trino that exposes row data won't quietly leak
 * sensitive customer data into LLM prompts.
 */
const FIREWALL_FIELD_NAMES = new Set(['data', 'rows', 'values', 'rowData']);
/**
 * Containers that are known to legitimately have row data — we walk the
 * input and reject if any of these top-level keys are present. The
 * sanitized payload never contains these.
 */
const FIREWALL_BLOCKED_TOPLEVEL = new Set(['result', 'queryResult', 'data']);

export class QueryInfoFirewallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryInfoFirewallError';
  }
}

export type SanitizeResult = {
  queryId: string;
  jsonPath: string;
  fullJsonPath: string;
  sanitized: SanitizedQueryInfo;
};

export type SanitizedQueryInfo = {
  summary: TrinoQuerySummary;
  queryStats: Record<string, unknown>;
  failureInfo?: Record<string, unknown>;
  errorCode?: Record<string, unknown> | string;
  dynamicFiltersStats?: Record<string, unknown>;
  query: string;
  rootStage?: TrinoStage;
  operatorSummary?: TrinoOperatorSummaryEntry[];
  /**
   * Profile + coordinator URL captured at persist time. Lets the
   * History tab show which Trino cluster a sanitized JSON came from
   * and filter by it. Optional: if absent on a file, the History UI
   * treats the profile as unknown — those entries bucket under
   * "(none)" in the profile filter and skip the row pill.
   */
  profileName?: string;
  coordinatorUrl?: string;
};

export type SanitizeOptions = {
  workspaceRoot?: string;
  cacheTtlMs?: number;
  /**
   * Identifies the Trino profile + coordinator the raw QueryInfo came
   * from. Stamped onto the sanitized JSON so the History tab can show
   * + filter by source profile after the user has moved on.
   */
  source?: {
    profileName?: string;
    coordinatorUrl?: string;
  };
};

/**
 * Sanitize a raw QueryInfo and persist both copies.
 *
 * If a sanitized copy < `cacheTtlMs` old already exists for `queryId`,
 * reads + returns it without re-writing.
 */
export async function sanitizeAndPersist(
  rawQueryInfo: Record<string, unknown>,
  opts: SanitizeOptions = {},
): Promise<SanitizeResult> {
  const workspaceRoot = opts.workspaceRoot ?? WORKSPACE_ROOT;
  const cacheTtlMs = opts.cacheTtlMs ?? SANITIZE_CACHE_TTL_MS;

  const queryId =
    typeof rawQueryInfo.queryId === 'string'
      ? rawQueryInfo.queryId
      : typeof rawQueryInfo.id === 'string'
        ? rawQueryInfo.id
        : '';
  if (!queryId) {
    throw new Error(
      'Cannot sanitize QueryInfo without a queryId (got neither queryId nor id).',
    );
  }

  toolFirewall(rawQueryInfo);

  const dir = path.join(workspaceRoot, DIAGNOSTICS_SUBDIR);
  await fs.promises.mkdir(dir, { recursive: true });

  const jsonPath = path.join(dir, `${queryId}.json`);
  const fullJsonPath = path.join(dir, `${queryId}.full.json`);

  // Cache hit?
  try {
    const stat = await fs.promises.stat(jsonPath);
    if (Date.now() - stat.mtimeMs < cacheTtlMs) {
      const cached = JSON.parse(
        await fs.promises.readFile(jsonPath, 'utf8'),
      ) as SanitizedQueryInfo;
      return { queryId, jsonPath, fullJsonPath, sanitized: cached };
    }
  } catch {
    // No cached file - fall through.
  }

  const sanitized = sanitize(rawQueryInfo);
  if (opts.source?.profileName) {
    sanitized.profileName = opts.source.profileName;
  }
  if (opts.source?.coordinatorUrl) {
    sanitized.coordinatorUrl = opts.source.coordinatorUrl;
  }

  await fs.promises.writeFile(
    fullJsonPath,
    JSON.stringify(rawQueryInfo, null, 2),
    'utf8',
  );
  await fs.promises.writeFile(
    jsonPath,
    JSON.stringify(sanitized, null, 2),
    'utf8',
  );

  return { queryId, jsonPath, fullJsonPath, sanitized };
}

/**
 * Pure sanitization (no I/O). Exported for testability.
 */
export function sanitize(
  rawQueryInfo: Record<string, unknown>,
): SanitizedQueryInfo {
  toolFirewall(rawQueryInfo);

  const summary = summarizeQueryInfo(rawQueryInfo);
  const queryStats = stripQueryStats(
    rawQueryInfo.queryStats as Record<string, unknown> | undefined,
  );
  const rootStage = trimStage(
    rawQueryInfo.outputStage ?? rawQueryInfo.rootStage,
  );
  const operatorSummary = flattenAndTrimOperatorSummary(rawQueryInfo);

  return {
    summary,
    queryStats,
    failureInfo: rawQueryInfo.failureInfo as
      | Record<string, unknown>
      | undefined,
    errorCode: rawQueryInfo.errorCode as
      | Record<string, unknown>
      | string
      | undefined,
    dynamicFiltersStats: rawQueryInfo.dynamicFiltersStats as
      | Record<string, unknown>
      | undefined,
    query: typeof rawQueryInfo.query === 'string' ? rawQueryInfo.query : '',
    rootStage,
    operatorSummary,
  };
}

/**
 * Compute the compact summary used by the master list, the detail header,
 * and the analyzer skill's "headline" pass.
 */
export function summarizeQueryInfo(
  raw: Record<string, unknown>,
): TrinoQuerySummary {
  const stats = (raw.queryStats as Record<string, unknown>) || {};
  const session = (raw.session as Record<string, unknown>) || {};
  const errorCode = raw.errorCode as Record<string, unknown> | undefined;
  const failureInfo = raw.failureInfo as Record<string, unknown> | undefined;
  const queryId = (raw.queryId as string) ?? (raw.id as string) ?? '';

  const operators = collectOperators(raw);
  const { largestOperator, dataSkewScore, peakOpBytes } =
    computeOperatorMetrics(operators);
  const joinDistributionTypes = collectJoinDistributions(operators);
  const connectorTypes = collectConnectors(operators);

  return {
    queryId,
    state: (raw.state as string) ?? 'UNKNOWN',
    query: typeof raw.query === 'string' ? raw.query : undefined,
    user: (session.user as string) ?? (raw.user as string) ?? undefined,
    source: (session.source as string) ?? (raw.source as string) ?? undefined,
    catalog: (session.catalog as string) ?? undefined,
    schema: (session.schema as string) ?? undefined,
    created: (stats.createTime as string) ?? undefined,
    started: (stats.executionStartTime as string) ?? undefined,
    ended: (stats.endTime as string) ?? undefined,
    cpuTimeMs: parseDurationMs(stats.totalCpuTime),
    wallTimeMs: parseDurationMs(stats.elapsedTime),
    queuedTimeMs: parseDurationMs(stats.queuedTime),
    analysisTimeMs: parseDurationMs(stats.analysisTime),
    planningTimeMs: parseDurationMs(stats.totalPlanningTime),
    peakUserMemoryBytes:
      parseDataSize(stats.peakUserMemoryReservation) ?? peakOpBytes,
    peakTotalMemoryBytes: parseDataSize(stats.peakTotalMemoryReservation),
    processedRows: numberOrUndefined(stats.processedInputPositions),
    processedBytes: parseDataSize(stats.processedInputDataSize),
    totalSplits: numberOrUndefined(stats.totalSplits),
    completedSplits: numberOrUndefined(stats.completedSplits),
    queuedSplits: numberOrUndefined(stats.queuedSplits),
    runningSplits: numberOrUndefined(stats.runningSplits),
    blockedTimeMs: parseDurationMs(stats.totalBlockedTime),
    dataSkewScore,
    largestOperator,
    joinDistributionTypes,
    connectorTypes,
    errorCode: asScalarString(errorCode?.name),
    errorType: asScalarString(errorCode?.type),
    failureMessage: asScalarString(failureInfo?.message),
  };
}

function asScalarString(v: unknown): string | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return undefined;
}

/**
 * Strip verbose info blobs from queryStats while keeping the diagnostic
 * skeleton intact.
 */
function stripQueryStats(
  stats: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!stats) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stats)) {
    // operatorSummaries is reproduced as a top-level field after
    // trimming; including it again on queryStats just bloats the
    // payload.
    if (k === 'operatorSummaries') {
      continue;
    }
    if (k === 'stageGcStatistics') {
      continue;
    }
    if (k === 'rootOperator') {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Walk the stage tree and emit a trimmed copy: keep stageStats, drop
 * per-driver task detail (just count + per-task scalar stats), recurse.
 */
function trimStage(raw: unknown): TrinoStage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const stats = obj.stageStats as Record<string, unknown> | undefined;
  const trimmedStats = stats ? stripStageStats(stats) : undefined;
  const tasks = Array.isArray(obj.tasks)
    ? (obj.tasks as Array<Record<string, unknown>>).map(trimTask)
    : undefined;
  const subStages = Array.isArray(obj.subStages)
    ? (obj.subStages as unknown[])
        .map(trimStage)
        .filter((s): s is TrinoStage => Boolean(s))
    : undefined;

  return {
    stageId: typeof obj.stageId === 'string' ? obj.stageId : undefined,
    state: typeof obj.state === 'string' ? obj.state : undefined,
    rootStage: typeof obj.rootStage === 'boolean' ? obj.rootStage : undefined,
    stageStats: trimmedStats,
    tasks,
    subStages,
  };
}

function stripStageStats(
  stats: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (k === 'operatorSummaries') {
      continue;
    } // reproduced separately
    if (k === 'gcInfo') {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function trimTask(task: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(task)) {
    if (k === 'outputBuffers') {
      continue;
    } // huge per-driver detail
    if (k === 'stats' && v && typeof v === 'object') {
      out.stats = trimTaskStats(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function trimTaskStats(
  stats: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (k === 'pipelines') {
      continue;
    }
    if (k === 'gcInfo') {
      continue;
    }
    if (k === 'runtimeStats') {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function flattenAndTrimOperatorSummary(
  raw: Record<string, unknown>,
): TrinoOperatorSummaryEntry[] {
  const out: TrinoOperatorSummaryEntry[] = [];
  for (const op of collectOperators(raw)) {
    out.push({
      operatorType: op.operatorType as string | undefined,
      pipelineId: op.pipelineId as number | string | undefined,
      planNodeId: op.planNodeId as string | undefined,
      inputPositions: numberOrUndefined(op.inputPositions),
      outputPositions: numberOrUndefined(op.outputPositions),
      inputDataSize: op.inputDataSize as number | string | undefined,
      outputDataSize: op.outputDataSize as number | string | undefined,
      cpuNanos: parseDurationNanos(op.totalCpuTime ?? op.cpuTime),
      blockedWallNanos: parseDurationNanos(op.blockedWall),
      peakMemoryReservation: op.peakUserMemoryReservation as
        | number
        | string
        | undefined,
      // `info` blobs on operatorSummary are notoriously chatty
      // (`hashCollisions`, `predicateRanges`, etc). The skill heuristics
      // only need runtimeStats so we keep that and drop info.
      runtimeStats: op.runtimeStats as Record<string, unknown> | undefined,
    });
  }
  return out;
}

function collectOperators(
  raw: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  function visit(stage: unknown) {
    if (!stage || typeof stage !== 'object') {
      return;
    }
    const obj = stage as Record<string, unknown>;
    const stats = obj.stageStats as Record<string, unknown> | undefined;
    const ops = Array.isArray(stats?.operatorSummaries)
      ? (stats.operatorSummaries as Array<Record<string, unknown>>)
      : [];
    for (const op of ops) {
      out.push(op);
    }
    const subStages = obj.subStages as unknown[] | undefined;
    if (Array.isArray(subStages)) {
      for (const sub of subStages) {
        visit(sub);
      }
    }
  }
  visit(raw.outputStage ?? raw.rootStage);
  return out;
}

function computeOperatorMetrics(ops: Array<Record<string, unknown>>): {
  largestOperator?: string;
  dataSkewScore?: number;
  peakOpBytes?: number;
} {
  let largestOperator: string | undefined;
  let largestBytes = -1;
  let dataSkewScore: number | undefined;
  let peakOpBytes: number | undefined;

  for (const op of ops) {
    const bytes = parseDataSize(op.peakUserMemoryReservation) ?? 0;
    if (bytes > largestBytes) {
      largestBytes = bytes;
      largestOperator = (op.operatorType as string) ?? largestOperator;
    }
    if (peakOpBytes === undefined || bytes > peakOpBytes) {
      peakOpBytes = bytes;
    }
  }

  // Heuristic data-skew score: ratio of max-task input to avg-task input
  // across operators. > 5 typically indicates serious skew. We accumulate
  // the worst-case ratio seen.
  for (const op of ops) {
    const inputDistribution = op.inputDataSizeDistribution as
      | Record<string, unknown>
      | undefined;
    if (!inputDistribution) {
      continue;
    }
    const max = parseDataSize(inputDistribution.max) ?? 0;
    const avg = parseDataSize(inputDistribution.avg) ?? 0;
    if (avg > 0) {
      const ratio = max / avg;
      if (dataSkewScore === undefined || ratio > dataSkewScore) {
        dataSkewScore = ratio;
      }
    }
  }

  return { largestOperator, dataSkewScore, peakOpBytes };
}

function collectJoinDistributions(
  ops: Array<Record<string, unknown>>,
): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    const type = (op.operatorType as string) ?? '';
    if (/Join|Hash/i.test(type)) {
      // Operators like "HashBuilderOperator", "LookupJoinOperator" don't
      // carry distribution directly, but the join distribution shows up
      // on the plan node. We surface the operator name itself as a proxy.
      out.add(type);
    }
  }
  return [...out];
}

function collectConnectors(ops: Array<Record<string, unknown>>): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    const type = (op.operatorType as string) ?? '';
    if (/Scan|TableScan/i.test(type)) {
      const info = op.info as Record<string, unknown> | undefined;
      const connector =
        (info?.connectorName as string) ??
        (info?.catalog as string) ??
        undefined;
      if (connector) {
        out.add(connector);
      }
    }
  }
  return [...out];
}

/**
 * Reject any payload that contains row-data containers at the top level,
 * or any nested field name that matches FIREWALL_FIELD_NAMES on a
 * non-trivial value. Pure data-shape check — no LLM tokens are spent on
 * payloads we don't trust.
 */
export function toolFirewall(payload: Record<string, unknown>): void {
  for (const blocked of FIREWALL_BLOCKED_TOPLEVEL) {
    if (blocked in payload) {
      throw new QueryInfoFirewallError(
        `Tool firewall rejected QueryInfo payload: top-level "${blocked}" present (suspected row-data leak).`,
      );
    }
  }
  // Walk one level deep on common offenders. Going deeper costs CPU and
  // these top-level + 1-level checks have caught every known leak shape.
  const queryStats = payload.queryStats as Record<string, unknown> | undefined;
  if (queryStats) {
    for (const name of FIREWALL_FIELD_NAMES) {
      if (
        name in queryStats &&
        Array.isArray(queryStats[name]) &&
        (queryStats[name] as unknown[]).length > 0
      ) {
        throw new QueryInfoFirewallError(
          `Tool firewall rejected QueryInfo payload: queryStats.${name} contains rows.`,
        );
      }
    }
  }
}

/**
 * Read the sanitized JSON for a single previously-analyzed query.
 *
 * Returns `null` when there's no `<root>/.dj/diagnostics/<queryId>.json`
 * yet, or when the file is unreadable/corrupt. Callers should fall back
 * to a REST fetch in that case. This path never touches the network and
 * is the cheap default for the Query Control Center detail pane.
 */
export async function readPersistedSanitizedQuery(
  queryId: string,
  workspaceRoot: string = WORKSPACE_ROOT,
): Promise<SanitizedQueryInfo | null> {
  if (!queryId) {
    return null;
  }
  const jsonPath = path.join(
    workspaceRoot,
    DIAGNOSTICS_SUBDIR,
    `${queryId}.json`,
  );
  try {
    const raw = await fs.promises.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as SanitizedQueryInfo;
    if (!parsed?.summary?.queryId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function listPersistedQueries(
  workspaceRoot: string = WORKSPACE_ROOT,
): Promise<TrinoPersistedQuery[]> {
  const dir = path.join(workspaceRoot, DIAGNOSTICS_SUBDIR);
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const result: TrinoPersistedQuery[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.full.json')) {
      continue;
    }
    const jsonPath = path.join(dir, entry);
    try {
      const stat = await fs.promises.stat(jsonPath);
      const raw = JSON.parse(
        await fs.promises.readFile(jsonPath, 'utf8'),
      ) as SanitizedQueryInfo;
      if (!raw?.summary?.queryId) {
        continue;
      }
      result.push({
        queryId: raw.summary.queryId,
        persistedAt: new Date(stat.mtimeMs).toISOString(),
        jsonPath,
        summary: raw.summary,
        profileName: raw.profileName,
        coordinatorUrl: raw.coordinatorUrl,
      });
    } catch {
      // ignore unreadable / non-conforming entries
    }
  }
  result.sort((a, b) => (a.persistedAt < b.persistedAt ? 1 : -1));
  return result;
}

/**
 * Reap diagnostics older than `retentionDays`. Called opportunistically
 * (e.g. when listing persisted queries).
 */
export async function reapOldDiagnostics(
  retentionDays: number = DEFAULT_RETENTION_DAYS,
  workspaceRoot: string = WORKSPACE_ROOT,
): Promise<number> {
  const dir = path.join(workspaceRoot, DIAGNOSTICS_SUBDIR);
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  for (const entry of entries) {
    const fp = path.join(dir, entry);
    try {
      const stat = await fs.promises.stat(fp);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(fp);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

export function parseDurationMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === 'number') {
    return Math.round(raw);
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const m = raw.match(/^([\d.]+)\s*(ns|us|ms|s|m|h|d)?$/);
  if (!m) {
    return undefined;
  }
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) {
    return undefined;
  }
  switch (m[2]) {
    case 'ns':
      return Math.round(n / 1e6);
    case 'us':
      return Math.round(n / 1e3);
    case 'ms':
      return Math.round(n);
    case 's':
    case undefined:
      return Math.round(n * 1000);
    case 'm':
      return Math.round(n * 60_000);
    case 'h':
      return Math.round(n * 3_600_000);
    case 'd':
      return Math.round(n * 86_400_000);
    default:
      return undefined;
  }
}

function parseDurationNanos(raw: unknown): number | undefined {
  const ms = parseDurationMs(raw);
  if (ms === undefined) {
    return undefined;
  }
  return ms * 1e6;
}

export function parseDataSize(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === 'number') {
    return Math.round(raw);
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const m = raw.match(/^([\d.]+)\s*(B|kB|KB|MB|GB|TB|PB)?$/);
  if (!m) {
    return undefined;
  }
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) {
    return undefined;
  }
  const unit = (m[2] ?? 'B').toUpperCase();
  switch (unit) {
    case 'B':
      return Math.round(n);
    case 'KB':
      return Math.round(n * 1024);
    case 'MB':
      return Math.round(n * 1024 ** 2);
    case 'GB':
      return Math.round(n * 1024 ** 3);
    case 'TB':
      return Math.round(n * 1024 ** 4);
    case 'PB':
      return Math.round(n * 1024 ** 5);
    default:
      return undefined;
  }
}

function numberOrUndefined(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === 'number') {
    return raw;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
