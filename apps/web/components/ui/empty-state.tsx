import type {ReactNode} from 'react';

// Show a message when a list has no items
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  // Icon shown above the message
  icon: ReactNode;
  // Heading shown to the user
  title: string;
  // Short text below the heading
  description: string;
  // Extra content for this section
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center px-4 py-12 text-center sm:min-h-80">
      <div
        className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-accent text-ink/60 [&_svg]:size-7"
        aria-hidden="true"
      >
        {icon}
      </div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
        {description}
      </p>
      {children}
    </div>
  );
}
