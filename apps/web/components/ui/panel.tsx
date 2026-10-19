import type {ComponentProps} from 'react';

// Show a shared panel for page content
export function Panel({className = '', ...props}: ComponentProps<'section'>) {
  return (
    <section
      className={`min-w-0 rounded-2xl border border-border bg-panel p-5 shadow-xs sm:p-6 ${className}`}
      {...props}
    />
  );
}
