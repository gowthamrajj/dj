import type { DjModelMatch, TrinoQuerySummary } from '@shared/trino/types';
import { Box, Text } from '@web/elements';

import { formatDateTime } from '../format';
import { LabeledValue } from './LabeledValue';
import { ModelLabel } from './ModelLabel';
import { Section } from './Section';

export type MetadataCardProps = {
  summary: TrinoQuerySummary;
  /**
   * DJ model match resolved server-side. `undefined` while the full
   * snapshot hasn't been fetched yet (summary mode), `null` once the
   * matcher has run and produced no link. See `ModelLabel` for the
   * three render states.
   */
  modelMatch?: DjModelMatch | null;
  className?: string;
};

/**
 * Left-hand card on the Overview tab. Groups the query's identifying
 * fields (DJ Model / User / Source / Catalog / Schema) and lifecycle
 * timestamps (Created / Started / Ended) into two `Section`s.
 */
export function MetadataCard({
  summary,
  modelMatch,
  className,
}: MetadataCardProps) {
  return (
    <Box variant="bordered" className={className}>
      <Text variant="label">Metadata</Text>
      <div className="mt-3 flex flex-col gap-3">
        <Section title="Identification">
          <ModelLabel modelMatch={modelMatch} />
          <LabeledValue label="User" value={summary.user} />
          <LabeledValue label="Source" value={summary.source} />
          <LabeledValue label="Catalog" value={summary.catalog} />
          <LabeledValue label="Schema" value={summary.schema} />
        </Section>
        <Section title="Timing">
          <LabeledValue
            label="Created"
            value={formatDateTime(summary.created)}
          />
          <LabeledValue
            label="Started"
            value={formatDateTime(summary.started)}
          />
          <LabeledValue label="Ended" value={formatDateTime(summary.ended)} />
        </Section>
      </div>
    </Box>
  );
}
