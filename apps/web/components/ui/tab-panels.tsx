'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';

type Phase = 'starting' | 'running' | 'idle';
interface Transition {
  // Only one outgoing panel is kept during a switch
  value: string;
  from: string | null;
  phase: Phase;
  version: number;
  direction: string;
}
interface Motion extends Transition {
  // Start both panels as soon as the new tab is mounted
  ready: (version: number) => void;
  // Release the old panel after motion or a deliberate interaction
  finish: (version: number) => void;
}
const Context = createContext<Motion | null>(null);

// Keep the old and new panel in one grid cell until their shared slide ends
export function TabPanels({
  group,
  value,
  children,
  className = '',
}: {
  group: string;
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [transition, setTransition] = useState<Transition>({
    value,
    from: null,
    phase: 'idle',
    version: 0,
    direction: 'forward',
  });
  if (transition.value !== value) {
    const source = transition.value;
    setTransition({
      value,
      from: source,
      phase: 'starting',
      version: transition.version + 1,
      direction: transition.direction,
    });
  }
  const finish = useCallback((version: number) => {
    setTransition((old) =>
      old.version === version && old.phase !== 'idle'
        ? {...old, from: null, phase: 'idle'}
        : old,
    );
  }, []);
  const ready = useCallback(
    (version: number) => {
      const tabs = document
        .getElementById(`${group}-tab-${value}`)
        ?.closest<HTMLElement>('[role="tablist"]');
      const direction = tabs?.dataset.slideDirection ?? 'forward';
      const animate =
        typeof matchMedia === 'function' &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTransition((old) =>
        old.version !== version || old.phase !== 'starting'
          ? old
          : {
              ...old,
              direction,
              phase: animate ? 'running' : 'idle',
              from: animate ? old.from : null,
            },
      );
    },
    [group, value],
  );
  useEffect(() => {
    if (transition.phase !== 'running') return;
    // Recover missing events without cutting off a running or paused slide
    let timer: ReturnType<typeof setTimeout>;
    function recover() {
      const moving = root.current
        ?.getAnimations?.({subtree: true})
        .some((animation) => {
          const target = (animation.effect as KeyframeEffect | null)
            ?.target as Element | null;
          return (
            target?.hasAttribute('data-tab-slide') &&
            target.closest('[data-tab-panels]') === root.current &&
            (animation.playState === 'running' ||
              animation.playState === 'paused')
          );
        });
      if (!document.hidden && moving) {
        timer = setTimeout(recover, 500);
        return;
      }
      finish(transition.version);
    }
    timer = setTimeout(recover, 700);
    return () => clearTimeout(timer);
  }, [transition.phase, transition.version, finish]);
  return (
    <Context value={{...transition, ready, finish}}>
      <div
        ref={root}
        className={`grid items-start ${className}`}
        data-tab-panels={group}
      >
        {children}
      </div>
    </Context>
  );
}

// Share one start and finish time across sibling panels
export function useTabMotion() {
  return useContext(Context);
}
