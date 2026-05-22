import { describe, expect, it } from '@jest/globals';
import {
  QueryInfoFirewallError,
  readPersistedSanitizedQuery,
  sanitize,
  sanitizeAndPersist,
  summarizeQueryInfo,
  toolFirewall,
} from '@services/trino/queryJsonSanitizer';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeRawQueryInfo(overrides: Record<string, unknown> = {}) {
  return {
    queryId: '20250511_120000_00000_test',
    state: 'FINISHED',
    session: {
      user: 'tester',
      source: 'dbt-trino-1.7.17',
      catalog: 'hive',
      schema: 'analytics',
    },
    queryStats: {
      createTime: '2025-05-11T12:00:00Z',
      executionStartTime: '2025-05-11T12:00:01Z',
      endTime: '2025-05-11T12:00:55Z',
      totalCpuTime: '40.20s',
      elapsedTime: '54.00s',
      queuedTime: '0.50s',
      analysisTime: '0.20s',
      totalPlanningTime: '0.30s',
      totalBlockedTime: '4.00s',
      peakUserMemoryReservation: '800MB',
      peakTotalMemoryReservation: '900MB',
      processedInputPositions: 1_200_000,
      processedInputDataSize: '120MB',
      totalSplits: 180,
      completedSplits: 180,
      queuedSplits: 0,
      runningSplits: 0,
      stageGcStatistics: { large: 'blob' },
      operatorSummaries: [{ operatorType: 'LookupJoinOperator' }],
    },
    query:
      '/* {"app": "dbt", "node_id": "model.my_project.int__finance__daily"} */\nselect 1',
    outputStage: {
      stageId: 'stage_0',
      state: 'FINISHED',
      stageStats: {
        totalCpuTime: '20s',
        operatorSummaries: [
          {
            operatorType: 'LookupJoinOperator',
            pipelineId: 1,
            planNodeId: 'pl1',
            inputPositions: 1_200_000,
            outputPositions: 1_180_000,
            totalCpuTime: '18s',
            peakUserMemoryReservation: '600MB',
            inputDataSizeDistribution: { max: '50MB', avg: '5MB' },
          },
          {
            operatorType: 'TableScanOperator',
            pipelineId: 0,
            planNodeId: 'pl0',
            inputPositions: 1_200_000,
            outputPositions: 1_200_000,
            totalCpuTime: '8s',
            peakUserMemoryReservation: '120MB',
            info: { connectorName: 'hive', catalog: 'hive' },
          },
        ],
      },
      tasks: [
        {
          taskId: 't1',
          stats: { foo: 'bar', pipelines: ['drop-me'] },
          outputBuffers: { drop: 'me' },
        },
      ],
      subStages: [],
    },
    ...overrides,
  };
}

describe('toolFirewall', () => {
  it('rejects payloads with top-level result key', () => {
    expect(() => toolFirewall({ result: { data: [[1]] } })).toThrow(
      QueryInfoFirewallError,
    );
  });

  it('rejects payloads with top-level data key', () => {
    expect(() => toolFirewall({ data: [[1]] })).toThrow(QueryInfoFirewallError);
  });

  it('rejects queryStats.rows row data', () => {
    expect(() => toolFirewall({ queryStats: { rows: [[1, 2]] } })).toThrow(
      QueryInfoFirewallError,
    );
  });

  it('accepts well-formed QueryInfo payloads', () => {
    expect(() => toolFirewall(makeRawQueryInfo())).not.toThrow();
  });
});

describe('summarizeQueryInfo', () => {
  it('extracts headline stats from queryStats and session', () => {
    const s = summarizeQueryInfo(makeRawQueryInfo());
    expect(s.queryId).toBe('20250511_120000_00000_test');
    expect(s.state).toBe('FINISHED');
    expect(s.user).toBe('tester');
    expect(s.source).toBe('dbt-trino-1.7.17');
    expect(s.catalog).toBe('hive');
    expect(s.schema).toBe('analytics');
    expect(s.wallTimeMs).toBeGreaterThan(0);
    expect(s.cpuTimeMs).toBeGreaterThan(0);
    expect(s.peakUserMemoryBytes).toBeGreaterThan(0);
    expect(s.totalSplits).toBe(180);
  });

  it('reports the largest operator and its peak memory', () => {
    const s = summarizeQueryInfo(makeRawQueryInfo());
    expect(s.largestOperator).toBe('LookupJoinOperator');
  });

  it('computes data-skew score from inputDataSizeDistribution', () => {
    const s = summarizeQueryInfo(makeRawQueryInfo());
    // 50MB max / 5MB avg = 10
    expect(s.dataSkewScore).toBeCloseTo(10, 1);
  });

  it('surfaces connector types from TableScanOperator info', () => {
    const s = summarizeQueryInfo(makeRawQueryInfo());
    expect(s.connectorTypes).toContain('hive');
  });

  it('surfaces error code and failure message on failed queries', () => {
    const raw = makeRawQueryInfo({
      state: 'FAILED',
      errorCode: {
        name: 'EXCEEDED_LOCAL_MEMORY_LIMIT',
        type: 'INSUFFICIENT_RESOURCES',
      },
      failureInfo: { message: 'Per-node memory limit exceeded' },
    });
    const s = summarizeQueryInfo(raw);
    expect(s.state).toBe('FAILED');
    expect(s.errorCode).toBe('EXCEEDED_LOCAL_MEMORY_LIMIT');
    expect(s.errorType).toBe('INSUFFICIENT_RESOURCES');
    expect(s.failureMessage).toBe('Per-node memory limit exceeded');
  });
});

describe('sanitize', () => {
  it('drops stageGcStatistics and per-driver task detail', () => {
    const s = sanitize(makeRawQueryInfo());
    expect(s.queryStats.stageGcStatistics).toBeUndefined();
    expect(s.queryStats.operatorSummaries).toBeUndefined();
    // tasks[].outputBuffers and tasks[].stats.pipelines stripped
    const task = (s.rootStage?.tasks ?? [])[0];
    expect(task?.outputBuffers).toBeUndefined();
    const stats = task?.stats as Record<string, unknown> | undefined;
    expect(stats?.pipelines).toBeUndefined();
    expect(stats?.foo).toBe('bar');
  });

  it('reproduces the operator summary at top level with trimmed fields', () => {
    const s = sanitize(makeRawQueryInfo());
    expect(s.operatorSummary).toBeDefined();
    expect(s.operatorSummary!.length).toBe(2);
    const first = s.operatorSummary![0];
    expect(first.operatorType).toBe('LookupJoinOperator');
    expect(first.cpuNanos).toBeGreaterThan(0);
  });

  it('keeps the query_comment verbatim so findModelForSql can read the node_id', () => {
    const s = sanitize(makeRawQueryInfo());
    expect(s.query).toContain(
      '"node_id": "model.my_project.int__finance__daily"',
    );
  });
});

describe('sanitizeAndPersist', () => {
  it('writes <queryId>.json and <queryId>.full.json to the workspace .dj/diagnostics dir', async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-trino-test-'),
    );
    try {
      const raw = makeRawQueryInfo();
      const res = await sanitizeAndPersist(raw, { workspaceRoot: tmp });
      expect(res.queryId).toBe('20250511_120000_00000_test');
      expect(fs.existsSync(res.jsonPath)).toBe(true);
      expect(fs.existsSync(res.fullJsonPath)).toBe(true);
      const sanitizedOnDisk = JSON.parse(
        await fs.promises.readFile(res.jsonPath, 'utf8'),
      );
      expect(sanitizedOnDisk.summary.queryId).toBe(
        '20250511_120000_00000_test',
      );
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reuses cached sanitized output when called twice in quick succession', async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-trino-test-'),
    );
    try {
      const raw = makeRawQueryInfo();
      const first = await sanitizeAndPersist(raw, { workspaceRoot: tmp });
      const firstMtime = (await fs.promises.stat(first.jsonPath)).mtimeMs;
      await sanitizeAndPersist(raw, { workspaceRoot: tmp });
      const secondMtime = (await fs.promises.stat(first.jsonPath)).mtimeMs;
      expect(secondMtime).toBe(firstMtime);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to sanitize a payload that smells like row data', async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-trino-test-'),
    );
    try {
      const raw = makeRawQueryInfo({ result: { data: [[1, 2, 3]] } });
      await expect(
        sanitizeAndPersist(raw, { workspaceRoot: tmp }),
      ).rejects.toThrow(QueryInfoFirewallError);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('readPersistedSanitizedQuery', () => {
  it('returns null when there is no diagnostics dir', async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-trino-test-'),
    );
    try {
      const out = await readPersistedSanitizedQuery(
        '20250511_120000_00000_test',
        tmp,
      );
      expect(out).toBeNull();
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('round-trips a previously-persisted sanitized payload', async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-trino-test-'),
    );
    try {
      const raw = makeRawQueryInfo();
      await sanitizeAndPersist(raw, { workspaceRoot: tmp });
      const out = await readPersistedSanitizedQuery(
        '20250511_120000_00000_test',
        tmp,
      );
      expect(out).not.toBeNull();
      expect(out!.summary.queryId).toBe('20250511_120000_00000_test');
      expect(out!.summary.state).toBe('FINISHED');
      expect(out!.query).toContain('node_id');
      expect(out!.operatorSummary?.length).toBeGreaterThan(0);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns null for an empty queryId', async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-trino-test-'),
    );
    try {
      const out = await readPersistedSanitizedQuery('', tmp);
      expect(out).toBeNull();
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when the persisted file is corrupt JSON', async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-trino-test-'),
    );
    try {
      const dir = path.join(tmp, '.dj', 'diagnostics');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, 'bad_query.json'),
        '{not json',
        'utf8',
      );
      const out = await readPersistedSanitizedQuery('bad_query', tmp);
      expect(out).toBeNull();
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});
