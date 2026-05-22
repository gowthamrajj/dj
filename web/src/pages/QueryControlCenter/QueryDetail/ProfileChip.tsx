export type ProfileChipProps = {
  name: string;
  url?: string;
};

/**
 * Compact chip showing the Trino profile (and optionally its
 * coordinator URL) a snapshot was captured against. Rendered in the
 * Query Info header next to the loaded-from label so the cluster
 * identity is visible even after switching active profiles.
 */
export function ProfileChip({ name, url }: ProfileChipProps) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded border border-neutral text-xs"
      title={
        url
          ? `Captured from profile "${name}" (${url})`
          : `Captured from profile "${name}"`
      }
    >
      <span className="font-semibold">{name}</span>
      {url && (
        <span className="ml-1 opacity-70 truncate max-w-[12rem]">· {url}</span>
      )}
    </span>
  );
}
