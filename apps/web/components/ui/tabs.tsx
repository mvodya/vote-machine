'use client';
import {useState, type ReactNode} from 'react';
import {SelectionIndicator} from './selection-indicator';
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
  group,
  value,
  onChange,
  label,
}: {
  // Prefix shared with each tab panel
  group: string;
  // Tabs to show
  items: Tab[];
  // Selected tab ID
  value: string;
  // Select a tab by its ID
  onChange: (id: string) => void;
  // Name of the tab group
  label: string;
}) {
  const index = items.findIndex((tab) => tab.id === value);
  // Derive direction only from a committed selection, including confirmed exits
  const [selection, setSelection] = useState({
    value,
    index,
    direction: 'forward',
  });
  if (selection.value !== value)
    setSelection({
      value,
      index,
      direction: index < selection.index ? 'backward' : 'forward',
    });
  return (
    <div
      className="relative isolate flex min-w-0 gap-1 rounded-2xl border border-border bg-panel p-1.5 shadow-xs"
      data-slide-direction={selection.direction}
      role="tablist"
      aria-label={label}
    >
      <SelectionIndicator
        value={value}
        itemsKey={items.map((tab) => `${tab.id}:${tab.label}`).join('|')}
        selector='[role="tab"][aria-selected="true"]'
        className="border-border/60 bg-accent shadow-xs"
      />
      {items.map((tab, index) => (
        <Button
          key={tab.id}
          variant="tab"
          className="relative z-10"
          role="tab"
          id={`${group}-tab-${tab.id}`}
          aria-controls={`${group}-panel-${tab.id}`}
          aria-selected={value === tab.id}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={(event) => {
            // Safari may leave focus inside the panel that is about to hide
            event.currentTarget.focus({preventScroll: true});
            onChange(tab.id);
          }}
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
          <span className="max-w-full min-w-0 break-words">{tab.label}</span>
        </Button>
      ))}
    </div>
  );
}
