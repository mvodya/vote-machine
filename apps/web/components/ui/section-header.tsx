import type {ReactNode} from 'react';

// Show a section title and its actions
export function SectionHeader({
  title,
  children,
}: {
  // Heading shown to the user
  title: string;
  // Extra content for this section
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}
