import type {ComponentProps} from 'react';
import {SelectionInput} from './selection-input';
import {fieldDescription, type FieldProps} from './field';

// Keep a checkbox next to its label and help text
export function CheckboxField({
  id,
  label,
  hint,
  error,
  className = '',
  'aria-describedby': describedBy,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & FieldProps) {
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="flex items-start gap-3 text-sm leading-6 text-ink"
      >
        <SelectionInput
          id={id}
          type="checkbox"
          className="mt-1 size-4"
          aria-describedby={fieldDescription(id, hint, error, describedBy)}
          aria-invalid={error ? true : undefined}
          {...props}
        />
        <span>{label}</span>
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 pl-7 text-xs leading-5 text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 pl-7 text-sm text-error-ink"
        >
          {error}
        </p>
      )}
    </div>
  );
}
