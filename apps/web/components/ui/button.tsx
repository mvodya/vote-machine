import type {ComponentProps, ReactNode} from 'react';

// Shared button styles
const variants = {
  swatch:
    'size-10 min-h-10 border border-border bg-panel p-1.5 text-ink hover:border-primary aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary/30',
  positive:
    'min-h-10 border border-success-ink/20 bg-success-bg px-3 py-2 text-sm text-success-ink hover:bg-success-bg/80',
  negative:
    'min-h-10 border border-error-ink/20 bg-error-bg px-3 py-2 text-sm text-error-ink hover:bg-error-bg/80',
  waiting:
    'min-h-10 border border-warning-ink/20 bg-warning-bg px-3 py-2 text-sm text-warning-ink',
  primary:
    'min-h-11 border border-ink bg-primary px-4 py-2.5 text-sm text-on-primary shadow-xs hover:bg-primary/90',
  secondary:
    'min-h-11 border border-border bg-panel px-4 py-2.5 text-sm text-ink shadow-xs hover:border-ink/25 hover:bg-page',
  switch:
    'min-h-10 flex-1 border border-transparent px-3 py-2.5 text-sm text-muted hover:text-ink aria-pressed:border-primary/35 aria-pressed:bg-selected aria-pressed:text-ink aria-pressed:shadow-xs',
  selector:
    'relative z-10 min-h-10 flex-1 border border-transparent px-3 py-2.5 text-sm text-muted hover:text-ink aria-pressed:text-ink',
  ghost: 'min-h-10 p-2.5 text-sm text-muted hover:bg-ink/5 hover:text-ink',
  tab: 'min-w-0 flex-1 flex-col px-1.5 py-3 text-[11px] text-muted hover:bg-page aria-selected:text-ink sm:flex-none sm:flex-row sm:px-5 sm:text-sm',
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
      className={`inline-flex items-center gap-2 rounded-xl font-medium leading-5 transition-[background-color,color,border-color,box-shadow,opacity,scale] duration-200 ease-out motion-safe:active:scale-[0.97] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 ${fullWidth ? 'w-full justify-between' : 'justify-center'} ${variants[variant]} ${className}`}
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
