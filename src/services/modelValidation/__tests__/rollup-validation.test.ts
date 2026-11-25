import {
  validateRollupInterval,
  validateRollupOutputColumns,
  validateWeeklyGrainOrder,
  validateWeekStartDay,
} from '@services/modelValidation';
import type { FrameworkColumn } from '@shared/framework/types';

describe('rollup validation', () => {
  it('accepts week rollup interval and rejects unsupported intervals', () => {
    expect(
      validateRollupInterval({
        from: { model: 'x', rollup: { interval: 'week' } },
      }),
    ).toEqual([]);

    const errors = validateRollupInterval({
      from: { model: 'x', rollup: { interval: 'quarter' } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/quarter/);
    expect(errors[0].message).toMatch(/day, hour, week, month, year/);
  });

  it('validates week_start_day project variable', () => {
    expect(validateWeekStartDay(undefined)).toEqual([]);
    expect(validateWeekStartDay('monday')).toEqual([]);
    expect(validateWeekStartDay('Sunday')).toEqual([]);

    const invalid = validateWeekStartDay('funday', {
      from: { model: 'x', rollup: { interval: 'week' } },
    });
    expect(invalid).toHaveLength(1);
    expect(invalid[0].severity).toBe('error');
    expect(invalid[0].instancePath).toBe('/from/rollup/interval');
    expect(invalid[0].message).toMatch(/week_start_day/);
  });

  it('rejects week rollup from an upstream monthly or yearly CTE', () => {
    const errors = validateWeeklyGrainOrder({
      ctes: [
        {
          name: 'monthly',
          from: { model: 'daily_orders', rollup: { interval: 'month' } },
          select: ['store_id'],
        },
      ],
      from: { cte: 'monthly', rollup: { interval: 'week' } },
      select: ['store_id'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].instancePath).toBe('/from/rollup/interval');
    expect(errors[0].message).toMatch(/month/);
  });

  it('flags non-suffix fct columns on rollup models', () => {
    const columns: FrameworkColumn[] = [
      {
        name: 'utilization_pct',
        meta: { type: 'fct' },
        internal: { expr: 'allocated_gb / total_gb' },
      },
    ];
    const errors = validateRollupOutputColumns(
      { from: { model: 'x', rollup: { interval: 'month' } } },
      columns,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/utilization_pct/);
  });
});
