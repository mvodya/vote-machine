'use client';
import type {ComponentProps} from 'react';
import {Field, controlClass, fieldDescription, type FieldProps} from './field';
// Show a list or longer text with the shared field styles
export function TextareaField({
  id,
  label,
  hint,
  error,
  className = '',
  'aria-describedby': describedBy,
  ...props
}: ComponentProps<'textarea'> & FieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        className={`${controlClass} min-h-28 resize-y py-3 ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldDescription(id, hint, error, describedBy)}
        {...props}
      />
    </Field>
  );
}
