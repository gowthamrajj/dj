---
name: dj-trino-analyzer
description: >-
  Diagnose Trino query performance from a sanitized QueryInfo JSON.
  Use when the user mentions "trino slow", "explain why query is slow",
  "trino query plan", "broadcast vs partitioned join", "data skew",
  "trino blocked time", "operator memory", or asks to investigate a
  specific Trino query ID against a .dj/diagnostics/<id>.json file
  produced by the DJ Query Control Center.
compatibility: DJ (Data JSON) Framework workspace with .dj/diagnostics/ written by `DJ: Analyze Trino Query with AI`
metadata:
  dj-skill: '1.0'
---

# Analyze a Trino query plan + runtime stats

This skill operates on a **sanitized Trino `QueryInfo` JSON** written by
the DJ extension at **`.dj/diagnostics/<queryId>.json`**. The companion
**`.dj/diagnostics/<queryId>.full.json`** is the raw coordinator
response (for audit / deep dive). The sanitized file is shaped for
LLM token budgets — read it first.

## Reading order

1. **`summary`** — the headline view. State, CPU vs wall time, peak
   memory, splits, blocked time, `dataSkewScore`, `largestOperator`,
   connectors, plus `errorCode` / `failureMessage` for failed queries.
   **Always start here.** Most diagnoses can be made from `summary`
   alone.
2. **`failureInfo` + `errorCode`** — present when `state === "FAILED"`.
   Quote the message back to the user and skip to the recommendation.
3. **`operatorSummary`** — flat list of operators across all stages.
   Sort by `peakMemoryReservation` desc to find the hot spot.
4. **`rootStage`** — full stage tree, only if the operator summary alone
   doesn't explain the slowness.
5. **`dynamicFiltersStats`** — dynamic-filter effectiveness; key for
   join-pushdown diagnoses.
6. **`query`** (the SQL text) — used to map the query back to a DJ
   model. The DJ extension resolves this server-side and writes the
   result to a `modelMatch` field on the QueryInfo (when present in the
   raw JSON, surfaced as `summary.modelMatch` in the sanitized view).
   The match can come from three signals, in order of confidence:
   - **`comment`** — `dbt` injects `/* {"app": "dbt", …, "node_id":
     "model.<project>.<modelName>", …} */` at the top of every query it
     submits (enabled by default in `dbt_core`).
   - **`fqn`** — extracted from the materialization target in
     `CREATE TABLE/VIEW "<catalog>"."<schema>"."<modelName>" AS …` or
     `INSERT INTO …`.
   - **`cte`** — the trailing `SELECT * FROM <modelName>` in dbt's
     compiled SQL form, used when no DDL wrapper is present.
   If none resolves, the query is ad-hoc (or dbt's `query-comment` was
   disabled in `dbt_project.yml`) — say so plainly rather than
   guessing.

Do **not** ask the coordinator for additional data. If you need
something not in this JSON, recommend the user re-run the analysis
(which re-fetches the latest QueryInfo) or open the **full.json**
manually.

## Performance heuristics

Apply these in order. Cite the field you used.

### 1. Broadcast-join blow-up

Symptom: a `LookupJoinOperator` or `HashJoinOperator` with
`peakMemoryReservation` close to the cluster's per-node memory limit,
or a `peakUserMemoryBytes` summary value > 50% of the per-node limit.

- Look at the operator's `inputPositions` — if the build side is
  large (>1M rows) and the join distribution is `BROADCAST`, that's a
  classic broadcast-join blow-up.
- Fix: force `PARTITIONED` distribution (Trino session property
  `join_distribution_type=PARTITIONED`), or shrink the build side by
  pushing predicates / using an `int_join_models` with explicit
  `where` filters upstream of the join.

### 2. Data skew

Symptom: `summary.dataSkewScore` > 5 (the ratio of max-task input to
avg-task input across operators).

- Inspect the offending stage in `rootStage.tasks[]`: look for the
  task with disproportionate input vs siblings.
- Common causes: a join key with high null/empty cardinality, a
  power-law distribution on the join key, or a hash collision.
- Fix: add `null`-handling to the join condition, or salt the join key
  (`coalesce(key, rand() * 1000)` on one side).

### 3. JSON parser CPU

Symptom: an operator with `operatorType` containing `Json` (e.g.
`JsonParserOperator`, `JsonExtractOperator`) consuming a large fraction
of `summary.cpuTimeMs`.

- Look at the stage's `stageStats.totalCpuTime` and the operator's
  `cpuNanos` — if the JSON op is > 30% of the stage CPU, that's the
  hot path.
- Fix: cast JSON columns to native types in a `stg_*` model so
  downstream models don't re-parse on every query. For one-off
  filtering, use `json_extract_scalar` with explicit JSON paths instead
  of full deserialization.

### 4. High `blockedTimeMs`

Symptom: `summary.blockedTimeMs` > 30% of `wallTimeMs`.

- The query is spending most of its wall time waiting (exchange,
  buffer, lock). Check the dominant operator's `blockedWallNanos`.
- Common causes: a downstream stage stalling on memory pressure;
  exchange buffer back-pressure when one stage outputs much faster
  than the consumer can drain; a long-running planning phase.
- Fix: parallelize the slow consumer (raise `task.concurrency`),
  reduce the upstream's output size with a predicate, or split a
  monolithic `mart_*` into smaller intermediate models.

### 5. S3 / object-store scan latency

Symptom: a `TableScanOperator` connector in
`summary.connectorTypes` is `hive` / `iceberg` / `delta_lake`, with
`outputDataSize` small but the operator's `blockedWallNanos` high.

- The scan is paying per-object latency overhead.
- Fix: enlarge file sizes upstream (target ~128MB-1GB parquet files),
  or restrict the scan with a partition predicate. If the model is a
  DJ staging model, set `materialization.partitions` on its parent.

### 6. Dynamic filter effectiveness

Symptom: `dynamicFiltersStats.dynamicFiltersCompleted` is much less
than `dynamicFiltersStats.totalDynamicFilters`, or
`dynamicFiltersStats.lazyDynamicFilters` is > 0.

- Trino didn't push the build side predicate down to the probe scan.
- Fix: ensure the join columns have appropriate statistics
  (`ANALYZE TABLE` if the connector supports it); if the probe table
  is bucketed, partition or bucket the build table on the same key.

### 7. Many small splits

Symptom: `summary.totalSplits` > 10 000 with low `processedBytes`.

- Per-split scheduling overhead dominates.
- Fix: compact source files (target Trino split size, typically
  ~64MB); on DJ models, set materialization partitions so dbt-trino
  produces fewer, larger output files.

### 8. Failed query

Symptom: `summary.state === "FAILED"`.

- Quote `summary.failureMessage` / `summary.errorCode` to the user.
- For `EXCEEDED_TIME_LIMIT`, examine `summary.queuedTimeMs` and
  `summary.planningTimeMs` — long queue / planning suggests the
  cluster is saturated, not the query.
- For `EXCEEDED_LOCAL_MEMORY_LIMIT`, fall back to the broadcast-join
  heuristic above.

## DJ model layering — performance expectations by type

When `summary.modelMatch.modelName` is present (or you can read it
straight out of the dbt query_comment `node_id`), the model name's
prefix tells you what shape of work to expect:

- **`stg_*`** — Trino → conformed columns. Should be cheap; high CPU
  here usually means JSON parsing or a `stg_union_sources` fanning out
  too many sources.
- **`int_*`** — joins, lookbacks, rollups. The expensive layer. Most
  broadcast-join blow-ups and data-skew issues land here.
- **`mart_*`** — analytics-ready. Materialized as views in DJ, so
  every query against a `mart_*` re-runs the entire upstream DAG.
  When a `mart_*` is slow, the fix is almost always upstream
  (cache an `int_*` as `materialization: incremental`).

Tie any recommendation back to the model layer when you can:
> "This query runs `int__finance__billing__daily_summary` which is the
> int layer where broadcast-join blow-ups are most common. The build
> side here is ~12M rows from `stg__finance__accounts` — shrink it with
> a `where` filter on `account_status = 'active'` upstream."

## Output format

Produce **three sections** in order:

1. **Headline** — one sentence: `state`, `wallTimeMs`,
   `peakUserMemoryBytes`, and the single most likely root cause from
   the heuristics above. Cite the field you used.
2. **Evidence** — bullet list of the supporting numbers from the
   sanitized JSON (operator name, CPU %, memory %, skew score, etc.).
3. **Recommendations** — at most 3 actionable items. Each item names
   the file or setting to change.

Do **not** output speculative changes to the SQL — the JSON sources of
truth are the `.model.json` files. Suggest the column / filter /
materialization knob to flip; the user will edit the model JSON.

## Safety rails

- **Never** request or accept row-level query results — the sanitizer
  strips those out and rejects payloads that contain them. If you
  catch yourself wanting `result.data`, stop: the diagnosis can
  always be made from operator + stage statistics.
- **Never** suggest editing the generated `.sql` or `.yml` — only
  the `.model.json` source of truth.
