import {LoaderCircle} from 'lucide-react';

// Use a compact busy state when a placeholder would hide useful content
export function Spinner({label = 'Загружаем…'}: {label?: string}) {
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 text-sm text-muted"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-4 motion-safe:animate-spin"
      />
      {label}
    </span>
  );
}

// Reserve list space while the first real snapshot is loading
export function Loading({
  label = 'Загружаем…',
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className="space-y-4 py-5">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
        {Array.from({length: rows}, (_, index) => (
          <div
            key={index}
            className="space-y-3 rounded-xl border border-border/60 p-4"
          >
            <div className="h-4 w-3/4 rounded bg-accent" />
            <div className="h-3 w-1/2 rounded bg-accent/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
