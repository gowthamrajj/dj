import { describe, expect, jest, test } from '@jest/globals';
import {
  frameworkBuildCteColumnRegistry,
  frameworkGenerateModelOutput,
  frameworkPartitionsDroppedByInterval,
} from '@services/framework/utils';
import {
  validateDjIcebergPartitionOverwrite,
  validateExcludeDatetimeRollupConflict,
  validatePartitionStrategyWithoutPartitions,
  validateRollupInterval,
  validateWeeklyGrainOrder,
  validateWeekStartDay,
} from '@services/modelValidation';
import { CacheManager } from '@services/sync/cacheManager';
import { ModelProcessor } from '@services/sync/ModelProcessor';
import type { SyncConfig, SyncResource } from '@services/sync/types';
import { ValidationService } from '@services/sync/ValidationService';
import { yamlParse } from '@shared';
import type { FrameworkCTE, FrameworkModel } from '@shared/framework/types';
import * as fs from 'fs';
import * as path from 'path';

import { createTestDJ, createTestProject } from './helpers';

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

function createDailyUpstreamProject(options?: {
  weekStartDay?: string;
  storageType?: string;
  parentPartitionMeta?: string[];
}) {
  return createTestProject({
    variables: {
      ...(options?.weekStartDay
        ? { week_start_day: options.weekStartDay }
        : {}),
      ...(options?.storageType ? { storage_type: options.storageType } : {}),
    },
    nodes: {
      ['model.project.int__sales__orders__daily']: {
        meta: options?.parentPartitionMeta
          ? { portal_partition_columns: options.parentPartitionMeta }
          : {},
        columns: {
          region: {
            name: 'region',
            data_type: 'varchar',
            meta: { type: 'dim' },
          },
          revenue_sum: {
            name: 'revenue_sum',
            data_type: 'bigint',
            meta: { type: 'fct' },
          },
          datetime: {
            name: 'datetime',
            data_type: 'timestamp(6)',
            meta: {
              type: 'dim',
              interval: 'day',
              dimension: { time_intervals: ['DAY', 'MONTH', 'YEAR'] },
            },
            internal: { interval: 'day' },
          },
          portal_partition_monthly: {
            name: 'portal_partition_monthly',
            data_type: 'date',
            meta: { type: 'dim' },
          },
          portal_partition_daily: {
            name: 'portal_partition_daily',
            data_type: 'date',
            meta: { type: 'dim' },
          },
          portal_source_count: {
            name: 'portal_source_count',
            data_type: 'bigint',
            meta: { type: 'fct' },
          },
        },
      },
    },
  });
}

describe('Weekly rollup grain', () => {
  describe('Grain partition drop helper', () => {
    test('drops partitions strictly finer than the target interval', () => {
      expect(Array.from(frameworkPartitionsDroppedByInterval('hour'))).toEqual(
        [],
      );
      expect(Array.from(frameworkPartitionsDroppedByInterval('day'))).toEqual([
        'portal_partition_hourly',
      ]);
      expect(Array.from(frameworkPartitionsDroppedByInterval('week'))).toEqual([
        'portal_partition_daily',
        'portal_partition_hourly',
      ]);
      expect(Array.from(frameworkPartitionsDroppedByInterval('month'))).toEqual(
        [
          'portal_partition_weekly',
          'portal_partition_daily',
          'portal_partition_hourly',
        ],
      );
      expect(Array.from(frameworkPartitionsDroppedByInterval('year'))).toEqual([
        'portal_partition_monthly',
        'portal_partition_weekly',
        'portal_partition_daily',
        'portal_partition_hourly',
      ]);
    });
  });

  describe('Weekly model built from daily model', () => {
    test('int_rollup_model emits month-clipped datetime, portal_partition_weekly, include="week" filters, and weekly unique_key', () => {
      const dj = createTestDJ();
      const project = createDailyUpstreamProject();
      const modelJson: FrameworkModel = {
        type: 'int_rollup_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly',
        materialization: 'incremental',
        from: {
          model: 'int__sales__orders__daily',
          rollup: { interval: 'week' },
        },
      };

      const { sql, yml } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });
      const norm = normalizeSql(sql);

      // Month-clipped datetime + date-typed weekly partition
      expect(norm).toContain(
        "greatest( date_trunc('week', datetime), date_trunc('month', datetime) ) as datetime",
      );
      expect(norm).toContain(
        "date_trunc('week', cast(datetime as date)) as portal_partition_weekly",
      );
      expect(norm).toContain('portal_partition_monthly');
      // Daily partition column is dropped from SELECT and GROUP BY, only kept in WHERE filter
      const selectClause = sql.split(/\bfrom\b/i)[0];
      const groupByClause =
        sql.split(/\bgroup by\b/i)[1]?.split(/\bselect\b/i)[0] ?? '';
      expect(selectClause).not.toContain('portal_partition_daily');
      expect(groupByClause).not.toContain('portal_partition_daily');

      // Default unique_key prioritizes portal_partition_weekly over portal_partition_monthly
      expect(sql).toContain('unique_key="portal_partition_weekly"');
      expect(sql).toContain(
        `"partitioned_by":"ARRAY['portal_partition_monthly', 'portal_partition_weekly']"`,
      );

      // Upstream date filters widen both monthly and daily predicates to full weeks
      expect(sql).toContain(
        '_ext_event_date_filter("portal_partition_monthly", data_type="date", include="week", interval="month")',
      );
      expect(sql).toContain(
        '_ext_event_date_filter("portal_partition_daily", data_type="date", include="week")',
      );

      // YAML schema metadata
      const parsedYml = yamlParse(yml) as {
        models: Array<{
          columns: Array<{
            name: string;
            data_type?: string;
            meta: {
              type?: string;
              dimension?: { label?: string; time_intervals?: string[] };
            };
          }>;
        }>;
      };
      const modelEntry = parsedYml.models[0];
      const colMap = new Map(modelEntry.columns.map((c) => [c.name, c]));
      expect(colMap.has('portal_partition_weekly')).toBe(true);
      expect(colMap.has('portal_partition_monthly')).toBe(true);
      expect(colMap.has('portal_partition_daily')).toBe(false);

      const weeklyCol = colMap.get('portal_partition_weekly')!;
      expect(weeklyCol.data_type).toBe('date');
      expect(weeklyCol.meta.type).toBe('dim');
      expect(weeklyCol.meta.dimension?.label).toBe('Portal Partition Weekly');

      const datetimeCol = colMap.get('datetime')!;
      expect(datetimeCol.meta.dimension?.time_intervals).toEqual([
        'MONTH',
        'WEEK',
        'YEAR',
      ]);
    });

    test('int_select_model with from.rollup week and parent portal_partition_columns meta still partitions by portal_partition_weekly', () => {
      const dj = createTestDJ();
      const project = createDailyUpstreamProject({
        parentPartitionMeta: [
          'portal_partition_monthly',
          'portal_partition_daily',
        ],
      });
      const modelJson: FrameworkModel = {
        type: 'int_select_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly_select',
        materialization: 'incremental',
        from: {
          model: 'int__sales__orders__daily',
          rollup: { interval: 'week' },
        },
        select: ['region', { name: 'revenue_sum', type: 'fct', agg: 'sum' }],
        group_by: 'dims',
      };

      const { sql } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });
      const norm = normalizeSql(sql);

      expect(norm).toContain(
        "greatest( date_trunc('week', datetime), date_trunc('month', datetime) ) as datetime",
      );
      expect(norm).toContain(
        "date_trunc('week', cast(datetime as date)) as portal_partition_weekly",
      );
      expect(sql).toContain(
        `"partitioned_by":"ARRAY['portal_partition_monthly', 'portal_partition_weekly']"`,
      );
      expect(sql).toContain('unique_key="portal_partition_weekly"');
    });
  });

  describe('Downstream monthly and weekly models reading from a weekly model', () => {
    function createWeeklyUpstreamProject() {
      return createTestProject({
        nodes: {
          ['model.project.int__sales__orders__weekly']: {
            columns: {
              region: {
                name: 'region',
                data_type: 'varchar',
                meta: { type: 'dim' },
              },
              revenue_sum: {
                name: 'revenue_sum',
                data_type: 'bigint',
                meta: { type: 'fct' },
              },
              datetime: {
                name: 'datetime',
                data_type: 'timestamp(6)',
                meta: {
                  type: 'dim',
                  interval: 'week',
                  dimension: { time_intervals: ['MONTH', 'WEEK', 'YEAR'] },
                },
                internal: { interval: 'week' },
              },
              portal_partition_monthly: {
                name: 'portal_partition_monthly',
                data_type: 'date',
                meta: { type: 'dim' },
              },
              portal_partition_weekly: {
                name: 'portal_partition_weekly',
                data_type: 'date',
                meta: { type: 'dim' },
              },
              portal_source_count: {
                name: 'portal_source_count',
                data_type: 'bigint',
                meta: { type: 'fct' },
              },
            },
          },
        },
      });
    }

    test('monthly model rolled up from weekly emits exact date_trunc(month, datetime) and drops portal_partition_weekly', () => {
      const dj = createTestDJ();
      const project = createWeeklyUpstreamProject();
      const modelJson: FrameworkModel = {
        type: 'int_rollup_model',
        group: 'sales',
        topic: 'orders',
        name: 'monthly',
        materialization: 'incremental',
        from: {
          model: 'int__sales__orders__weekly',
          rollup: { interval: 'month' },
        },
      };

      const { sql, yml } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });
      const norm = normalizeSql(sql);

      expect(norm).toContain("date_trunc('month', datetime) as datetime");
      expect(sql).not.toContain('portal_partition_weekly');
      expect(sql).toContain(
        `"partitioned_by":"ARRAY['portal_partition_monthly']"`,
      );
      expect(sql).toContain('unique_key="portal_partition_monthly"');
      expect(sql).toContain(
        '_ext_event_date_filter("portal_partition_monthly", data_type="date", interval="month")',
      );

      const parsedYml = yamlParse(yml) as {
        models: Array<{ columns: Array<{ name: string }> }>;
      };
      const colNames = parsedYml.models[0].columns.map((c) => c.name);
      expect(colNames).toContain('portal_partition_monthly');
      expect(colNames).not.toContain('portal_partition_weekly');
    });

    test('downstream weekly passthrough model filters portal_partition_weekly with interval="week" and emits bare datetime', () => {
      const dj = createTestDJ();
      const project = createWeeklyUpstreamProject();
      const modelJson: FrameworkModel = {
        type: 'int_select_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly_enriched',
        materialization: 'incremental',
        from: { model: 'int__sales__orders__weekly' },
        select: [
          { model: 'int__sales__orders__weekly', type: 'all_from_model' },
        ],
      };

      const { sql } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });

      // Same-grain weekly upstream already clipped datetime; no redundant greatest(...)
      expect(sql).not.toContain('greatest(');
      expect(sql).toContain('unique_key="portal_partition_weekly"');
      expect(sql).toContain(
        '_ext_event_date_filter("portal_partition_monthly", data_type="date", include="week", interval="month")',
      );
      expect(sql).toContain(
        '_ext_event_date_filter("portal_partition_weekly", data_type="date", interval="week")',
      );
    });
  });

  describe('Staging source path with week datetime interval', () => {
    test('stg_select_source with interval="week" passes include="week" to source filters and does not inject portal_partition_weekly', () => {
      const dj = createTestDJ();
      const project = createTestProject({
        sources: {
          ['source.project.raw__sales.events']: {
            name: 'events',
            source_name: 'raw__sales',
            meta: {
              partition_date: { expr: 'dt' },
              event_datetime: { expr: 'event_ts' },
            },
            columns: {
              region: { name: 'region', data_type: 'varchar' },
              dt: { name: 'dt', data_type: 'date' },
              event_ts: { name: 'event_ts', data_type: 'timestamp(6)' },
            },
          },
        },
      });
      const modelJson: FrameworkModel = {
        type: 'stg_select_source',
        group: 'sales',
        topic: 'orders',
        name: 'events_weekly',
        materialization: 'incremental',
        from: { source: 'raw__sales.events' },
        select: ['region', { name: 'datetime', interval: 'week' }],
      };

      const { sql, yml } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });
      const norm = normalizeSql(sql);

      expect(norm).toContain(
        "greatest( date_trunc('week', datetime), date_trunc('month', datetime) ) as datetime",
      );
      expect(sql).toContain(
        '_ext_partition_date_filter("dt", compile_dates=true, include="week", source_id="source.project.raw__sales.events")',
      );
      expect(sql).toContain(
        '_ext_event_datetime_filter("event_ts", include="week")',
      );
      expect(sql).not.toContain('portal_partition_weekly');

      const parsedYml = yamlParse(yml) as {
        models: Array<{ columns: Array<{ name: string }> }>;
      };
      const colNames = parsedYml.models[0].columns.map((c) => c.name);
      expect(colNames).not.toContain('portal_partition_weekly');
    });
  });

  describe('CTE-scoped weekly rollup', () => {
    test('CTE rollup week synthesizes portal_partition_weekly, clips datetime, and chains cleanly into a month CTE', () => {
      const dj = createTestDJ();
      const project = createDailyUpstreamProject();
      const ctes: [FrameworkCTE, ...FrameworkCTE[]] = [
        {
          name: 'weekly_stage',
          from: {
            model: 'int__sales__orders__daily',
            rollup: { interval: 'week' },
          },
          select: [
            { name: 'region', type: 'dim' },
            { name: 'revenue_sum', type: 'fct' },
          ],
        },
        {
          name: 'monthly_stage',
          from: {
            cte: 'weekly_stage',
            rollup: { interval: 'month' },
          },
          select: [
            { name: 'region', type: 'dim' },
            { name: 'revenue_sum', type: 'fct' },
          ],
        },
      ];
      const modelJson: FrameworkModel = {
        type: 'int_select_model',
        group: 'sales',
        topic: 'orders',
        name: 'monthly_via_weekly_cte',
        ctes,
        from: { cte: 'monthly_stage' },
        select: [{ cte: 'monthly_stage', type: 'all_from_cte' }],
      };

      const registry = frameworkBuildCteColumnRegistry({
        ctes,
        modelJson,
        project,
      });
      const weeklyCols = registry.get('weekly_stage')!.map((c) => c.name);
      expect(weeklyCols).toContain('portal_partition_weekly');
      expect(weeklyCols).toContain('portal_partition_monthly');
      expect(weeklyCols).not.toContain('portal_partition_daily');

      const monthlyCols = registry.get('monthly_stage')!.map((c) => c.name);
      expect(monthlyCols).toContain('portal_partition_monthly');
      expect(monthlyCols).not.toContain('portal_partition_weekly');

      const { sql } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });
      const norm = normalizeSql(sql);

      expect(norm).toContain(
        "greatest( date_trunc('week', datetime), date_trunc('month', datetime) ) as datetime",
      );
      expect(norm).toContain(
        "date_trunc('week', cast(datetime as date)) as portal_partition_weekly",
      );
      expect(sql).toContain(
        '_ext_event_date_filter("portal_partition_daily", data_type="date", include="week")',
      );
      expect(norm).toContain("date_trunc('month', datetime) as datetime");
    });
  });

  describe('Configurable week_start_day', () => {
    test('non-Monday week_start_day emits date_add day_of_week arithmetic for both datetime and portal_partition_weekly', () => {
      const dj = createTestDJ();
      const project = createDailyUpstreamProject({ weekStartDay: 'sunday' });
      const modelJson: FrameworkModel = {
        type: 'int_rollup_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly_sunday',
        materialization: 'incremental',
        from: {
          model: 'int__sales__orders__daily',
          rollup: { interval: 'week' },
        },
      };

      const { sql } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });
      const norm = normalizeSql(sql);

      // Sunday = ISO weekday 7
      expect(norm).toContain(
        "greatest( date_add( 'day', - ((day_of_week(datetime) + 7 - 7) % 7), cast(datetime as date) ), date_trunc('month', datetime) ) as datetime",
      );
      expect(norm).toContain(
        "date_add( 'day', - ((day_of_week(datetime) + 7 - 7) % 7), cast(datetime as date) ) as portal_partition_weekly",
      );
    });

    test('wednesday week_start_day uses ISO weekday 3', () => {
      const dj = createTestDJ();
      const project = createDailyUpstreamProject({ weekStartDay: 'Wednesday' });
      const modelJson: FrameworkModel = {
        type: 'int_rollup_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly_wednesday',
        from: {
          model: 'int__sales__orders__daily',
          rollup: { interval: 'week' },
        },
      };

      const { sql } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });
      const norm = normalizeSql(sql);

      expect(norm).toContain(
        "date_add( 'day', - ((day_of_week(datetime) + 7 - 3) % 7), cast(datetime as date) ) as portal_partition_weekly",
      );
    });
  });

  describe('Storage-type branching (Iceberg vs Delta Lake)', () => {
    test('emits partitioning ARRAY on Iceberg and partitioned_by ARRAY on Delta Lake', () => {
      const dj = createTestDJ();
      const modelJson: FrameworkModel = {
        type: 'int_rollup_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly_storage',
        materialization: 'incremental',
        from: {
          model: 'int__sales__orders__daily',
          rollup: { interval: 'week' },
        },
      };

      const icebergSql = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project: createDailyUpstreamProject({ storageType: 'iceberg' }),
      }).sql;
      const deltaSql = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project: createDailyUpstreamProject({ storageType: 'delta_lake' }),
      }).sql;

      expect(icebergSql).toContain(
        `"partitioning":"ARRAY['portal_partition_monthly', 'portal_partition_weekly']"`,
      );
      expect(icebergSql).not.toContain('partitioned_by');

      expect(deltaSql).toContain(
        `"partitioned_by":"ARRAY['portal_partition_monthly', 'portal_partition_weekly']"`,
      );
      expect(deltaSql).not.toContain('partitioning');
    });

    test('supports dj_iceberg_partition_overwrite on weekly Iceberg models', () => {
      const dj = createTestDJ();
      const project = createDailyUpstreamProject({ storageType: 'iceberg' });
      const modelJson: FrameworkModel = {
        type: 'int_rollup_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly_overwrite',
        materialization: {
          type: 'incremental',
          format: 'iceberg',
          strategy: { type: 'dj_iceberg_partition_overwrite' },
        },
        from: {
          model: 'int__sales__orders__daily',
          rollup: { interval: 'week' },
        },
      };

      const { sql } = frameworkGenerateModelOutput({
        dj,
        modelJson,
        project,
      });

      expect(sql).toContain(
        'incremental_strategy="dj_iceberg_partition_overwrite"',
      );
      expect(sql).not.toContain('unique_key');
      expect(sql).toContain(
        `"partitioning":"ARRAY['portal_partition_monthly', 'portal_partition_weekly']"`,
      );
      expect(
        validateDjIcebergPartitionOverwrite(modelJson, 'iceberg'),
      ).toHaveLength(0);
      expect(
        validatePartitionStrategyWithoutPartitions(modelJson),
      ).toHaveLength(0);
    });
  });

  describe('dj_iceberg_partition_overwrite macro weekly support', () => {
    const repoRoot = path.resolve(__dirname, '../../../../');
    const canonicalPath = path.join(repoRoot, 'macros/strategies.sql');
    const jaffleCopyPath = path.join(
      repoRoot,
      'docs/examples/jaffle_shop/macros/_ext_/strategies.sql',
    );

    test('handles portal_partition_weekly, honors week_start_day, skips monthly delete, and stays in sync with jaffle_shop', () => {
      const canonical = fs.readFileSync(canonicalPath, 'utf8');
      const jaffleCopy = fs.readFileSync(jaffleCopyPath, 'utf8');

      expect(jaffleCopy).toBe(canonical);
      expect(canonical).toContain(
        "set has_weekly = 'portal_partition_weekly' in partitioned_by",
      );
      expect(canonical).toContain(
        'set start_weekday = _ext_week_start_weekday()',
      );
      expect(canonical).toContain('portal_partition_weekly BETWEEN DATE');
      expect(canonical).toContain('portal_partition_weekly = DATE');
      expect(canonical).toContain('portal_partition_weekly IN (');
      expect(canonical).toContain(
        "if 'portal_partition_monthly' in partitioned_by and not has_weekly",
      );
    });
  });

  describe('Validation and diagnostic lifecycle', () => {
    test('accepts week in validateRollupInterval and rejects unsupported intervals', () => {
      expect(
        validateRollupInterval({
          type: 'int_rollup_model',
          from: { model: 'm', rollup: { interval: 'week' } },
        }),
      ).toEqual([]);

      expect(
        validateRollupInterval({
          type: 'int_rollup_model',
          from: { model: 'm', rollup: { interval: 'quarter' } },
        }),
      ).toHaveLength(1);
    });

    test('rejects week rollup or select from monthly or yearly upstream model and CTE', () => {
      const monthlyProject = createTestProject({
        nodes: {
          ['model.project.int__sales__orders__monthly']: {
            columns: {
              datetime: {
                name: 'datetime',
                data_type: 'timestamp(6)',
                meta: { type: 'dim', interval: 'month' },
                internal: { interval: 'month' },
              },
            },
          },
          ['model.project.int__sales__orders__yearly']: {
            columns: {
              datetime: {
                name: 'datetime',
                data_type: 'timestamp(6)',
                meta: { type: 'dim', interval: 'year' },
                internal: { interval: 'year' },
              },
            },
          },
        },
      });

      const modelErrors = validateWeeklyGrainOrder(
        {
          type: 'int_rollup_model',
          group: 'sales',
          topic: 'orders',
          name: 'bad_weekly',
          from: {
            model: 'int__sales__orders__monthly',
            rollup: { interval: 'week' },
          },
        },
        monthlyProject,
      );
      expect(modelErrors).toHaveLength(1);
      expect(modelErrors[0].message).toContain('"month"');

      const selectErrors = validateWeeklyGrainOrder(
        {
          type: 'int_select_model',
          group: 'sales',
          topic: 'orders',
          name: 'bad_weekly_select',
          from: { model: 'int__sales__orders__yearly' },
          select: [{ name: 'datetime', interval: 'week' }],
        },
        monthlyProject,
      );
      expect(selectErrors).toHaveLength(1);
      expect(selectErrors[0].message).toContain('"year"');

      const badCtes: [FrameworkCTE, ...FrameworkCTE[]] = [
        {
          name: 'monthly_cte',
          from: {
            model: 'int__sales__orders__daily',
            rollup: { interval: 'month' },
          },
          select: [{ name: 'region', type: 'dim' }],
        },
        {
          name: 'weekly_cte',
          from: {
            cte: 'monthly_cte',
            rollup: { interval: 'week' },
          },
          select: [{ name: 'region', type: 'dim' }],
        },
      ];
      const cteModel: FrameworkModel = {
        type: 'int_select_model',
        group: 'sales',
        topic: 'orders',
        name: 'bad_cte_weekly',
        ctes: badCtes,
        from: { cte: 'weekly_cte' },
        select: [{ cte: 'weekly_cte', type: 'all_from_cte' }],
      };
      const dailyProject = createDailyUpstreamProject();
      const registry = frameworkBuildCteColumnRegistry({
        ctes: badCtes,
        modelJson: cteModel,
        project: dailyProject,
      });
      const cteErrors = validateWeeklyGrainOrder(
        cteModel,
        dailyProject,
        registry,
      );
      expect(cteErrors).toHaveLength(1);
      expect(cteErrors[0].message).toContain('CTE "weekly_cte"');
    });

    test('rejects invalid week_start_day values and accepts all seven weekdays', () => {
      const weeklyModel = {
        type: 'int_rollup_model',
        from: { model: 'm', rollup: { interval: 'week' } },
      };

      for (const day of [
        'monday',
        'Tuesday',
        'WEDNESDAY',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ]) {
        expect(validateWeekStartDay(day, weeklyModel)).toEqual([]);
      }

      const errs = validateWeekStartDay('funday', weeklyModel);
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toContain('week_start_day');
    });

    test('rejects exclude_datetime and exclude_framework_artifacts combined with rollup: week', () => {
      expect(
        validateExcludeDatetimeRollupConflict({
          type: 'int_select_model',
          exclude_datetime: true,
          from: { model: 'm', rollup: { interval: 'week' } },
          select: ['region'],
        }),
      ).toHaveLength(1);

      expect(
        validateExcludeDatetimeRollupConflict({
          type: 'int_select_model',
          exclude_framework_artifacts: 'columns',
          from: { model: 'm', rollup: { interval: 'week' } },
          select: ['region'],
        }),
      ).toHaveLength(1);
    });

    test('validatePartitionStrategyWithoutPartitions accounts for synthesized portal_partition_weekly on week rollups', () => {
      // Excluding only monthly/daily/hourly on a week rollup still leaves portal_partition_weekly
      expect(
        validatePartitionStrategyWithoutPartitions(
          {
            type: 'int_select_model',
            materialization: { type: 'incremental' },
            from: { model: 'm', rollup: { interval: 'week' } },
            select: [{ name: 'region', type: 'dim' }],
            exclude_portal_partition_columns: [
              'portal_partition_monthly',
              'portal_partition_daily',
              'portal_partition_hourly',
            ],
          },
          'overwrite_existing_partitions',
        ),
      ).toHaveLength(0);

      // Excluding both monthly and weekly drops every partition emitted by a week rollup
      expect(
        validatePartitionStrategyWithoutPartitions(
          {
            type: 'int_select_model',
            materialization: { type: 'incremental' },
            from: { model: 'm', rollup: { interval: 'week' } },
            select: [{ name: 'region', type: 'dim' }],
            exclude_portal_partition_columns: [
              'portal_partition_monthly',
              'portal_partition_weekly',
            ],
          },
          'overwrite_existing_partitions',
        ),
      ).toHaveLength(1);
    });

    test('clears diagnostics in ValidationService and ModelProcessor once grain/var errors are fixed', async () => {
      const clearedUris: string[] = [];
      const warningCalls: Array<{ uri: string; count: number }> = [];
      const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const stubAjv = {
        getSchema: () => Object.assign(() => true, { errors: null }),
      } as unknown as ConstructorParameters<typeof ValidationService>[0];

      const validationService = new ValidationService(
        stubAjv,
        undefined,
        logger,
      );
      const badCteModel: FrameworkModel = {
        type: 'int_select_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly_from_monthly_cte',
        ctes: [
          {
            name: 'monthly_cte',
            from: {
              model: 'int__sales__orders__daily',
              rollup: { interval: 'month' },
            },
            select: [{ name: 'region', type: 'dim' }],
          },
          {
            name: 'weekly_cte',
            from: { cte: 'monthly_cte', rollup: { interval: 'week' } },
            select: [{ name: 'region', type: 'dim' }],
          },
        ],
        from: { cte: 'weekly_cte' },
        select: [{ cte: 'weekly_cte', type: 'all_from_cte' }],
      };
      expect(
        validationService.validateModel({
          modelJson: badCteModel,
          pathJson: '/tmp/bad.model.json',
        }).valid,
      ).toBe(false);

      const fixedCteModel: FrameworkModel = {
        type: 'int_select_model',
        group: 'sales',
        topic: 'orders',
        name: 'monthly_from_weekly_cte',
        ctes: [
          {
            name: 'weekly_cte',
            from: {
              model: 'int__sales__orders__daily',
              rollup: { interval: 'week' },
            },
            select: [{ name: 'region', type: 'dim' }],
          },
          {
            name: 'monthly_cte',
            from: { cte: 'weekly_cte', rollup: { interval: 'month' } },
            select: [{ name: 'region', type: 'dim' }],
          },
        ],
        from: { cte: 'monthly_cte' },
        select: [{ cte: 'monthly_cte', type: 'all_from_cte' }],
      };
      expect(
        validationService.validateModel({
          modelJson: fixedCteModel,
          pathJson: '/tmp/fixed.model.json',
        }).valid,
      ).toBe(true);

      // ModelProcessor sets diagnostics on invalid week_start_day and clears them once fixed
      const dj = createTestDJ();
      const syncConfig: SyncConfig = {
        extensionConfig: {
          ...dj.config,
          pythonModelGroups: [],
          logLevel: 'info',
          autoGenerateTests: {},
        },
        logger,
        enableChangeDetection: true,
        parallelBatchSize: 10,
      };
      const callbacks = {
        onDiagnosticsClear: (uri: { fsPath: string }) =>
          clearedUris.push(uri.fsPath),
        onModelValidationWarning: (
          uri: { fsPath: string },
          _message: string,
          errors?: unknown[],
        ) =>
          warningCalls.push({
            uri: uri.fsPath,
            count: errors?.length ?? 0,
          }),
      };

      const modelContent = JSON.stringify({
        type: 'int_rollup_model',
        group: 'sales',
        topic: 'orders',
        name: 'weekly',
        from: {
          model: 'int__sales__orders__daily',
          rollup: { interval: 'week' },
        },
      });
      const resource: SyncResource = {
        id: 'model.project.int__sales__orders__weekly',
        type: 'model',
        pathJson:
          '/tmp/project/models/intermediate/sales/orders/int__sales__orders__weekly.model.json',
        pathResource:
          '/tmp/project/models/intermediate/sales/orders/int__sales__orders__weekly.sql',
        parentIds: [],
        depth: 0,
      };

      const badProcessor = new ModelProcessor(
        syncConfig,
        new CacheManager(),
        callbacks,
      );
      await badProcessor.process({
        resource,
        jsonContent: modelContent,
        project: {
          ...createDailyUpstreamProject({ weekStartDay: 'not_a_day' }),
          pathSystem: '/tmp/project',
        },
      });
      expect(warningCalls).toHaveLength(1);
      expect(warningCalls[0].count).toBe(1);

      clearedUris.length = 0;
      warningCalls.length = 0;

      const fixedProcessor = new ModelProcessor(
        syncConfig,
        new CacheManager(),
        callbacks,
      );
      await fixedProcessor.process({
        resource,
        jsonContent: modelContent,
        project: {
          ...createDailyUpstreamProject({ weekStartDay: 'monday' }),
          pathSystem: '/tmp/project',
        },
      });
      expect(clearedUris).toContain(
        '/tmp/project/models/intermediate/sales/orders/int__sales__orders__weekly.model.json',
      );
      expect(warningCalls).toHaveLength(0);
    });
  });
});
