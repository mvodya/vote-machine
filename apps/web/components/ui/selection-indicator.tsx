'use client';
import {useLayoutEffect, useRef, useState} from 'react';

interface Position {
  // Bounds in the selector, independent of page scroll
  left: number;
  top: number;
  width: number;
  height: number;
}

// Slide one background between tabs without moving their labels
export function SelectionIndicator({
  value,
  itemsKey,
  selector,
  className = '',
}: {
  // Changes in selection or labels need a fresh measurement
  value: string;
  itemsKey: string;
  selector: string;
  className?: string;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  // Paint the first position before allowing later slides
  const [animate, setAnimate] = useState(false);
  const visible = position !== null;
  useLayoutEffect(() => {
    if (!visible) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setAnimate(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  useLayoutEffect(() => {
    const root = marker.current?.parentElement;
    if (!root) return;
    // Remeasure after font loading, resize or a wrapped row
    function measure() {
      const selected = root!.querySelector<HTMLElement>(selector);
      // Hidden panels have no useful bounds yet
      if (!selected || !selected.offsetWidth || !selected.offsetHeight) {
        setPosition(null);
        setAnimate(false);
        return;
      }
      const next = {
        left: selected.offsetLeft,
        top: selected.offsetTop,
        width: selected.offsetWidth,
        height: selected.offsetHeight,
      };
      setPosition((old) =>
        old &&
        Object.keys(next).every(
          (key) => old[key as keyof Position] === next[key as keyof Position],
        )
          ? old
          : next,
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root
      .querySelectorAll('button')
      .forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [value, itemsKey, selector]);
  return (
    <span
      ref={marker}
      aria-hidden="true"
      data-selection-indicator=""
      className={`pointer-events-none absolute top-0 left-0 rounded-xl border motion-safe:transition-[transform,width,height,background-color,border-color] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] ${className}`}
      style={{
        transition: animate ? undefined : 'none',
        visibility: position ? 'visible' : 'hidden',
        width: position?.width ?? 0,
        height: position?.height ?? 0,
        transform: `translate(${position?.left ?? 0}px, ${position?.top ?? 0}px)`,
      }}
    />
  );
}
