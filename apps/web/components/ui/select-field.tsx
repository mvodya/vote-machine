'use client';
import {ChevronDown} from 'lucide-react';
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
      <div className="relative">
        <select
          id={id}
          className={`${controlClass} h-12 pr-11 ${className}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={fieldDescription(id, hint, error)}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-muted"
        />
      </div>
    </Field>
  );
}
