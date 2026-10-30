'use client';
import {useI18n} from '../language-provider';
import {LoaderCircle} from 'lucide-react';

// Use a compact busy state when a placeholder would hide useful content
export function Spinner({label = 'Загружаем…'}: {label?: string}) {
  const {t} = useI18n();
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 text-sm text-muted"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-4 motion-safe:animate-spin"
      />
      {t(label)}
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
  const {t} = useI18n();
  return (
    <div
      data-loading-placeholder=""
      role="status"
      aria-label={t(label)}
      className="space-y-4 py-5"
    >
      <span className="sr-only">{t(label)}</span>
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
