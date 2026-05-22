import { sqlFormat, sqlToHtml } from '@shared/sql/utils';
import { Box, Button, Text } from '@web/elements';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { useMemo } from 'react';

export type QuerySqlCardProps = {
  sql?: string;
  className?: string;
};

/**
 * Right-hand card on the Overview tab. Pretty-prints the submitted
 * SQL with the shared `sqlFormat` + `sqlToHtml` pipeline (passed
 * through DOMPurify) and offers a Copy SQL button. Formatting
 * failures fall back to the raw text so the card never goes blank
 * on unusual SQL shapes.
 */
export function QuerySqlCard({ sql, className }: QuerySqlCardProps) {
  const sqlHtml = useMemo(() => {
    if (!sql) return null;
    try {
      const formatted = sqlFormat(sql);
      return DOMPurify.sanitize(sqlToHtml(formatted));
    } catch {
      return DOMPurify.sanitize(sql);
    }
  }, [sql]);
  return (
    <Box variant="bordered" className={className}>
      <div className="flex items-center justify-between">
        <Text variant="label">Query SQL</Text>
        <Button
          variant="secondary"
          label="Copy SQL"
          disabled={!sql}
          onClick={() => void navigator.clipboard.writeText(sql ?? '')}
        />
      </div>
      <div className="mt-2 overflow-auto text-xs font-mono">
        {sqlHtml ? parse(sqlHtml) : <span className="opacity-70">—</span>}
      </div>
    </Box>
  );
}
