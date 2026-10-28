'use client';
import motion from './motion.module.css';
import {useLayoutEffect, useState, type ReactNode} from 'react';
import {useTabMotion} from './tab-panels';

// Keep outgoing content visible but inert until the new panel finishes entering
export function TabPanel({
  group,
  id,
  value,
  className = '',
  children,
}: {
  // Names shared by the tab list and its content
  group: string;
  id: string;
  value: string;
  // Layout styles belong to the moving content
  className?: string;
  children: ReactNode;
}) {
  const transition = useTabMotion();
  const active = value === id;
  const leaving = !active && transition?.from === id;
  const [cached, setCached] = useState<ReactNode>(active ? children : null);
  // Preserve the actual mounted tree, including media and form state
  if (active && cached !== children) setCached(children);
  if (!active && !leaving && cached !== null) setCached(null);
  const version = transition?.version;
  const ready = transition?.ready;
  useLayoutEffect(() => {
    if (!active || !ready || version === undefined) return;
    // Media and request loading must never delay tab navigation
    ready(version);
  }, [active, ready, version]);
  const running = transition?.phase === 'running';
  const phase = leaving
    ? running
      ? 'exit'
      : undefined
    : active && running
      ? 'enter'
      : undefined;
  // Settle after the click target is known, before opening any popup
  function settle() {
    if (transition) transition.finish(transition.version);
  }
  return (
    <div
      id={`${group}-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`${group}-tab-${id}`}
      hidden={!active && !leaving}
      aria-hidden={!active || undefined}
      inert={!active}
      tabIndex={-1}
      data-motion={phase}
      data-slide-direction={transition?.direction}
      onClickCapture={settle}
      onKeyDownCapture={settle}
      className={`${motion.panel} col-start-1 row-start-1 min-w-0 rounded-xl outline-none`}
    >
      <div
        data-tab-slide=""
        className={`${motion.slide} min-w-0 ${className}`}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && transition)
            transition.finish(transition.version);
        }}
      >
        {active ? children : leaving ? cached : children}
      </div>
    </div>
  );
}
