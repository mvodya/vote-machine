import type {ComponentProps} from 'react';
import {Check} from 'lucide-react';

// Keep native keyboard behavior with the same mark in every browser
export function SelectionInput({
  type,
  className = '',
  dimDisabled = true,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & {
  type: 'checkbox' | 'radio';
  // A pending write can block input without flashing its color
  dimDisabled?: boolean;
}) {
  return (
    <span
      className={`relative inline-flex shrink-0 ${dimDisabled ? 'has-disabled:opacity-50' : ''} ${className}`}
    >
      <input
        type={type}
        {...props}
        className={`peer m-0 size-full motion-safe:transition-colors motion-safe:duration-200 appearance-none border border-muted bg-panel checked:border-primary focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ink ${type === 'radio' ? 'rounded-full' : 'rounded checked:bg-primary'}`}
      />
      {type === 'radio' ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-1 rounded-full bg-primary scale-50 opacity-0 motion-safe:transition-[scale,opacity] motion-safe:duration-200 peer-checked:scale-100 peer-checked:opacity-100"
        />
      ) : (
        <Check
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full text-on-primary scale-75 opacity-0 motion-safe:transition-[scale,opacity] motion-safe:duration-200 peer-checked:scale-100 peer-checked:opacity-100"
          strokeWidth={2.5}
        />
      )}
    </span>
  );
}
