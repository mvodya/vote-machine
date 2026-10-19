'use client';
import type {ReactNode} from 'react';
import {Button} from './button';

type Tab = {
  // Tab ID used by the page
  id: string;
  // Tab name shown to the user
  label: string;
  // Optional Lucide icon
  icon?: ReactNode;
};
// Show tabs with mouse and keyboard controls
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  // Tabs to show
  items: Tab[];
  // Selected tab ID
  value: string;
  // Select a tab by its ID
  onChange: (id: string) => void;
  // Name of the tab group
  label: string;
}) {
  return (
    <div
      className="flex min-w-0 gap-1 rounded-2xl border border-border bg-panel p-1.5 shadow-xs"
      role="tablist"
      aria-label={label}
    >
      {items.map((tab, index) => (
        <Button
          key={tab.id}
          variant="tab"
          role="tab"
          aria-selected={value === tab.id}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            // Arrow keys wrap across the ends of the list
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % items.length;
            else if (event.key === 'ArrowLeft')
              next = (index + items.length - 1) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else return;
            event.preventDefault();
            onChange(items[next]!.id);
            // Move focus to the selected tab
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus();
          }}
        >
          <span className="inline-flex size-4 shrink-0" aria-hidden="true">
            {tab.icon}
          </span>
          <span>{tab.label}</span>
        </Button>
      ))}
    </div>
  );
}
