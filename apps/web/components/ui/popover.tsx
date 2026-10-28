'use client';
import motion from './motion.module.css';
import {useEffect, useId, useRef, useState, type ReactNode} from 'react';

// Keep small information cards inside the visible screen
export function Popover({
  label,
  trigger,
  children,
  side = 'bottom',
  className = '',
}: {
  // Name shared by the trigger and card
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({left: 16, top: 16});
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    // Recheck bounds after scrolling or changing the phone orientation
    function place() {
      const anchor = button.current!.getBoundingClientRect();
      // Entry scaling must not change the final popup position
      const box = {
        width: card.current!.offsetWidth,
        height: card.current!.offsetHeight,
      };
      setPosition({
        left: Math.max(
          12,
          Math.min(anchor.right - box.width, innerWidth - box.width - 12),
        ),
        top: Math.max(
          12,
          Math.min(
            side === 'top' ? anchor.top - box.height - 10 : anchor.bottom + 10,
            innerHeight - box.height - 12,
          ),
        ),
      });
    }
    // Close without taking focus from an outside control
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    }
    place();
    const size = new ResizeObserver(place);
    size.observe(card.current!);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      size.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, side]);
  return (
    <span ref={root} className="inline-flex">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ink ${className}`}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={card}
          id={id}
          role="dialog"
          aria-label={label}
          style={{
            ...position,
            transformOrigin: side === 'top' ? 'bottom right' : 'top right',
          }}
          className={`${motion.popover} fixed z-50 max-h-[calc(100svh-1.5rem)] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl border border-border bg-panel p-5 text-left text-xs leading-5 font-normal text-ink shadow-xl`}
        >
          {children}
        </div>
      )}
    </span>
  );
}
