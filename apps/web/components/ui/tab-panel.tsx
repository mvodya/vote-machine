import type {ReactNode} from 'react';

// Link a panel to its tab and hide inactive content from keyboard users
export function TabPanel({
  group,
  id,
  value,
  className = '',
  children,
}: {
  // Shared prefix used by the matching tab list
  group: string;
  // This panel's tab ID
  id: string;
  // Current selected tab ID
  value: string;
  // Optional layout styles
  className?: string;
  // Panel content may keep local editor state while hidden
  children: ReactNode;
}) {
  return (
    <div
      id={`${group}-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`${group}-tab-${id}`}
      hidden={value !== id}
      tabIndex={0}
      className={`min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink ${className}`}
    >
      {children}
    </div>
  );
}
