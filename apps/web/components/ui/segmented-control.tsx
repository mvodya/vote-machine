'use client';
import type {ReactNode} from 'react';
import {Button} from './button';

// Choose one mode with the same compact button styles
export function SegmentedControl({
  label,
  value,
  items,
  onChange,
  disabled = false,
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
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap gap-1 rounded-xl bg-ink/5 p-1"
    >
      {items.map((item) => (
        <Button
          key={item.id}
          variant="switch"
          startIcon={item.icon}
          aria-pressed={value === item.id}
          disabled={disabled}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}
