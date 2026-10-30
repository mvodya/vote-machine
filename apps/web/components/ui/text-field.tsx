'use client';
import type {ComponentProps, ReactNode} from 'react';
import {Field, controlClass, fieldDescription, type FieldProps} from './field';
// Show a field with its label, hint and error
export function TextField({
  id,
  label,
  hint,
  error,
  endAction,
  className = '',
  'aria-describedby': describedBy,
  ...props
}: ComponentProps<'input'> &
  FieldProps & {
    // Small action inside the right edge of the field
    endAction?: ReactNode;
  }) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <div className="relative">
        <input
          id={id}
          className={`${controlClass} h-12 ${endAction ? 'pr-14' : ''} ${className}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={fieldDescription(id, hint, error, describedBy)}
          {...props}
        />
        {endAction && (
          <div className="absolute right-1 bottom-1">{endAction}</div>
        )}
      </div>
    </Field>
  );
}
