'use client';
import {useEffect, useRef} from 'react';
import {playSound} from './audio';
// Room alarms and visible timers share the same deduplication keys
export function useDeadlineSounds(deadlines: readonly string[]) {
  const previous = useRef(new Map<number, number>());
  const signature = deadlines.join(',');
  useEffect(() => {
    const times = signature.split(',').map(Date.parse).filter(Number.isFinite);
    for (const key of previous.current.keys())
      if (!times.includes(key)) previous.current.delete(key);
    for (const at of times)
      if (!previous.current.has(at)) {
        const remaining = Math.ceil((at - Date.now()) / 1000);
        previous.current.set(at, remaining === 60 ? 61 : remaining);
        if (remaining > 0 && remaining <= 10)
          playSound('tick', `${at}:tick:${remaining}`);
      }
    function tick() {
      for (const at of times) {
        const remaining = Math.ceil((at - Date.now()) / 1000);
        const before = previous.current.get(at) ?? remaining;
        // A delayed browser timer can skip the exact threshold
        if (before > 60 && remaining <= 60 && remaining > 0)
          playSound('minute', `${at}:minute`);
        if (remaining > 0 && remaining <= 10 && remaining !== before)
          playSound('tick', `${at}:tick:${remaining}`);
        previous.current.set(at, remaining);
      }
    }
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [signature]);
}
