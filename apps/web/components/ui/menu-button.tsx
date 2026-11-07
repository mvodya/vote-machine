'use client';
import {useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {ChevronDown} from 'lucide-react';
import {Button} from './button';
import motion from './motion.module.css';

// Keep a small action menu inside the viewport and support the keyboard
export function MenuButton({
  label,
  icon,
  items,
  onSelect,
  disabled = false,
}: {
  // Accessible name of the trigger and its menu
  label: string;
  icon?: ReactNode;
  // Each item can show a shared rich label with an icon
  items: {value: string; label: ReactNode}[];
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({left: 12, top: 12});
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    // Place and focus before the first paint so the menu never jumps
    function place() {
      const anchor = trigger.current!.getBoundingClientRect();
      setPosition({
        left: Math.max(
          12,
          Math.min(
            anchor.right - menu.current!.offsetWidth,
            innerWidth - menu.current!.offsetWidth - 12,
          ),
        ),
        top: Math.max(
          12,
          Math.min(
            anchor.bottom + 8,
            innerHeight - menu.current!.offsetHeight - 12,
          ),
        ),
      });
    }
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    place();
    menu.current
      ?.querySelector<HTMLButtonElement>('button')
      ?.focus({preventScroll: true});
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  return (
    <div ref={root} className="inline-flex">
      <Button
        ref={trigger}
        startIcon={icon}
        endIcon={<ChevronDown />}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
      </Button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          style={position}
          className={`${motion.popover} fixed z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-border bg-panel p-2 shadow-xl`}
          onKeyDown={(event) => {
            const buttons = Array.from(
              menu.current!.querySelectorAll<HTMLButtonElement>('button'),
            );
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
            if (event.key === 'Tab') setOpen(false);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (current +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        buttons.length) %
                      buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          {items.map((item) => (
            <Button
              key={item.value}
              role="menuitem"
              variant="ghost"
              fullWidth
              className="justify-start text-left"
              onClick={() => {
                setOpen(false);
                onSelect(item.value);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
