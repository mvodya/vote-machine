'use client';
import {useI18n} from '../language-provider';
import type {ReactNode} from 'react';
export interface FieldProps {
  // Input ID used by its label
  id: string;
  // Visible field label
  label: string;
  // Help below the field
  hint?: string;
  // Error below the field
  error?: string;
}
// Shared input styles for text, lists and choices
export const controlClass =
  'mt-2 block w-full appearance-none min-w-0 rounded-xl border border-border bg-panel px-4 text-base text-ink transition-[border-color,box-shadow,background-color,color] duration-200 motion-reduce:transition-none placeholder:text-muted focus:border-ink/50 focus:outline-none focus:ring-3 focus:ring-ink/10 disabled:opacity-50 read-only:bg-page/60 aria-invalid:border-error-ink sm:text-sm pointer-coarse:text-base';
// Connect hints and errors to their input
export function fieldDescription(
  id: string,
  hint?: string,
  error?: string,
  extra?: string,
) {
  return (
    [extra, hint ? `${id}-hint` : '', error ? `${id}-error` : '']
      .filter(Boolean)
      .join(' ') || undefined
  );
}
// Keep labels, hints and errors the same for every field type
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: FieldProps & {
  children: ReactNode;
}) {
  const {t} = useI18n();
  return (
    <div className="min-w-0">
      <label
        className="block text-sm font-medium leading-6 text-ink"
        htmlFor={id}
      >
        {t(label)}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-muted">
          {t(hint)}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-2 text-sm text-error-ink"
        >
          {t(error)}
        </p>
      )}
    </div>
  );
}
