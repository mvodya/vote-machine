'use client';
import type {ReactNode} from 'react';
import {SelectionIndicator} from './selection-indicator';
import {Button} from './button';

// Choose one mode with the same compact button styles
export function SegmentedControl({
  label,
  value,
  items,
  onChange,
  disabled = false,
  className = '',
}: {
  // Accessible group name
  label: string;
  // Selected mode
  value: string;
  // Available labels and optional icons
  items: {id: string; label: string; icon?: ReactNode}[];
  // Select one mode
  onChange: (value: string) => void;
  // Disable mode changes while saving
  disabled?: boolean;
  // Optional spacing for the shared selector
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`relative isolate flex flex-wrap gap-1 rounded-xl bg-ink/5 p-1 ${className}`}
    >
      <SelectionIndicator
        value={value}
        itemsKey={items.map((item) => `${item.id}:${item.label}`).join('|')}
        selector='button[aria-pressed="true"]'
        className="border-primary/35 bg-selected shadow-xs"
      />
      {items.map((item) => (
        <Button
          key={item.id}
          variant="selector"
          startIcon={item.icon}
          aria-pressed={value === item.id}
          disabled={disabled}
          onClick={(event) => {
            // Keep focus on the switch before hiding its previous content
            event.currentTarget.focus({preventScroll: true});
            onChange(item.id);
          }}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}
