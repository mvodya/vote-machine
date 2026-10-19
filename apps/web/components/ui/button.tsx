import type {ComponentProps, ReactNode} from 'react';

// Shared button styles
const variants = {
  positive:
    'min-h-10 border border-green-700/20 bg-green-50 px-3 py-2 text-sm text-green-800 hover:bg-green-100',
  negative:
    'min-h-10 border border-red-700/20 bg-red-50 px-3 py-2 text-sm text-red-800 hover:bg-red-100',
  waiting:
    'min-h-10 border border-amber-700/20 bg-amber-50 px-3 py-2 text-sm text-amber-800',
  primary:
    'min-h-11 border border-ink bg-ink px-4 py-2.5 text-sm text-white shadow-xs hover:bg-ink/90',
  secondary:
    'min-h-11 border border-border bg-white px-4 py-2.5 text-sm text-ink shadow-xs hover:border-ink/25 hover:bg-page',
  switch:
    'min-h-10 flex-1 px-3 py-2.5 text-sm text-ink/60 hover:text-ink aria-pressed:bg-white aria-pressed:text-ink aria-pressed:shadow-xs',
  ghost: 'min-h-10 p-2.5 text-sm text-ink/65 hover:bg-ink/5 hover:text-ink',
  tab: 'min-w-0 flex-1 flex-col px-1.5 py-3 text-[11px] text-ink/60 hover:bg-page aria-selected:bg-accent aria-selected:text-ink sm:flex-none sm:flex-row sm:px-5 sm:text-sm',
};

type Props = ComponentProps<'button'> & {
  // Button style
  variant?: keyof typeof variants;
  // Icon before the text
  startIcon?: ReactNode;
  // Icon after the text
  endIcon?: ReactNode;
  // Fill the parent width
  fullWidth?: boolean;
};

// Show a shared button with optional icons
export function Button({
  variant = 'primary',
  startIcon,
  endIcon,
  fullWidth = false,
  className = '',
  children,
  type = 'button',
  ...props
}: Props) {
  // Keep icons centered and prevent shrinking
  const iconClass = 'inline-flex size-4 shrink-0 items-center justify-center';
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-2 rounded-xl font-medium leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 ${fullWidth ? 'w-full justify-between' : 'justify-center'} ${variants[variant]} ${className}`}
      {...props}
    >
      {startIcon && (
        <span className={iconClass} aria-hidden="true">
          {startIcon}
        </span>
      )}
      {children}
      {endIcon && (
        <span className={iconClass} aria-hidden="true">
          {endIcon}
        </span>
      )}
    </button>
  );
}
