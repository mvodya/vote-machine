import type {ComponentProps} from 'react';

type Props = ComponentProps<'input'> & {
  // Room ID
  id: string;
  // Text shown next to the control
  label: string;
  // Extra help below the field
  hint?: string;
  // Error shown below the field
  error?: string;
};

// Show a field with its label, hint and error
export function TextField({
  id,
  label,
  hint,
  error,
  className = '',
  'aria-describedby': describedBy,
  ...props
}: Props) {
  // Link help and errors to the field for screen readers
  const description =
    [describedBy, hint ? `${id}-hint` : '', error ? `${id}-error` : '']
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className="min-w-0">
      <label
        className="block text-sm font-medium leading-6 text-ink"
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        className={`mt-2 block h-12 w-full min-w-0 rounded-xl border border-border bg-white px-4 text-sm text-ink transition-colors placeholder:text-ink/35 focus:border-ink/50 focus:outline-none focus:ring-3 focus:ring-ink/10 disabled:opacity-50 read-only:bg-page/60 aria-invalid:border-error-ink ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={description}
        {...props}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-2 text-sm text-error-ink"
        >
          {error}
        </p>
      )}
    </div>
  );
}
