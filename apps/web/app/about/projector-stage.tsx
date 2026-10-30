'use client';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import styles from './landing.module.css';

// Aim the light from the lens to the screen at every viewport size
export function ProjectorStage({children}: {children: ReactNode}) {
  const stage = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [beam, setBeam] = useState<CSSProperties>({opacity: 0});
  useEffect(() => {
    function measure() {
      if (!stage.current || !lens.current || !screen.current) return;
      const area = stage.current.getBoundingClientRect();
      const source = lens.current.getBoundingClientRect();
      const target = screen.current.getBoundingClientRect();
      const x = source.left + source.width / 2;
      const y = source.top + source.height / 2;
      // The cone reaches the near edge, then light covers the screen plane
      const left = Math.min(x, target.left);
      const top = Math.min(y, target.top);
      const down = y < target.top && x > target.left;
      const points = down
        ? [
            [x, y],
            [target.left, target.top],
            [target.left, target.bottom],
            [target.right, target.bottom],
            [target.right, target.top],
          ]
        : [
            [x, y],
            [target.left, target.top],
            [target.right, target.top],
            [target.right, target.bottom],
            [target.left, target.bottom],
          ];
      setBeam({
        left: left - area.left,
        top: top - area.top,
        width: Math.max(x, target.right) - left,
        height: Math.max(y, target.bottom) - top,
        clipPath: `polygon(${points.map(([px, py]) => `${px - left}px ${py - top}px`).join(',')})`,
        '--ray-x': `${x - left}px`,
        '--ray-y': `${y - top}px`,
        '--ray-angle': down ? '180deg' : '90deg',
      } as CSSProperties);
    }
    const observer = new ResizeObserver(measure);
    if (stage.current) observer.observe(stage.current);
    if (screen.current) observer.observe(screen.current);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={stage}
      className="relative mt-16 grid min-h-[400px] items-center gap-12 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] md:gap-20"
    >
      <div className={styles.projector} aria-hidden="true">
        <div className={styles.projectorTop}>
          <span />
          <span />
          <span />
        </div>
        <div className={styles.projectorFace}>
          <div ref={lens} data-projector-lens className={styles.lens} />
          <div className={styles.vents} />
        </div>
        <div className={styles.projectorFoot} />
      </div>
      <div
        ref={screen}
        data-projector-screen
        className="relative z-10 min-w-0 rounded-lg border-x-8 border-y-12 border-border/90 shadow-2xl shadow-primary/15"
      >
        {children}
        <div
          className="absolute -bottom-8 left-1/2 h-5 w-0.5 bg-border"
          aria-hidden="true"
        />
      </div>
      <div
        data-projector-beam
        className={styles.beam}
        style={beam}
        aria-hidden="true"
      />
    </div>
  );
}
