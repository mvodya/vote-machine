'use client';
import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {CircleHelp} from 'lucide-react';

// Show short help on hover, focus or click
export function Help({
  label,
  children,
}: {
  // Accessible name for this help button
  label: string;
  // Reusable help content
  children: ReactNode;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = pinned || hovered || focused;
  useEffect(() => {
    // Outside clicks close a pinned help card
    function close(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setPinned(false);
    }
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <span
      ref={root}
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={`Справка: ${label}`}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex size-7 items-center justify-center rounded-full text-muted hover:bg-ink/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        onFocus={(event) =>
          setFocused(event.currentTarget.matches(':focus-visible'))
        }
        onBlur={() => setFocused(false)}
        onClick={() => setPinned((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setPinned(false);
            setFocused(false);
            setHovered(false);
          }
        }}
      >
        <CircleHelp size={16} aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute top-full right-0 z-30 mt-2 block w-64 max-w-[calc(100vw-3rem)] rounded-xl border border-border bg-white p-4 text-left text-xs leading-5 font-normal break-words text-ink shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
