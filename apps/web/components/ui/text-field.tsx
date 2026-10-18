import type {ComponentProps} from 'react';
import {Field, controlClass, fieldDescription, type FieldProps} from './field';

// Show a field with its label, hint and error
export function TextField({
  id,
  label,
  hint,
  error,
  className = '',
  'aria-describedby': describedBy,
  ...props
}: ComponentProps<'input'> & FieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        className={`${controlClass} h-12 ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldDescription(id, hint, error, describedBy)}
        {...props}
      />
    </Field>
  );
}
