import type {ComponentProps} from 'react';
import {Field, controlClass, fieldDescription, type FieldProps} from './field';

// Use native choice controls with the shared labels and errors
export function SelectField({
  id,
  label,
  hint,
  error,
  className = '',
  children,
  ...props
}: ComponentProps<'select'> & FieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        className={`${controlClass} h-12 ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldDescription(id, hint, error)}
        {...props}
      >
        {children}
      </select>
    </Field>
  );
}
