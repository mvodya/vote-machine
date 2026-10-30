'use client';
import {useI18n} from './language-provider';
import {useEffect, useRef} from 'react';
import {Check} from 'lucide-react';
// Show new answers without moving the counter or nearby buttons
export function AnswerCount({
  count,
}: {
  // Latest saved answer count from the room snapshot
  count: number;
}) {
  const {t} = useI18n();
  const previous = useRef(count);
  const layer = useRef<HTMLSpanElement>(null);
  const flights = useRef(new Map<Animation, HTMLSpanElement>());
  useEffect(() => {
    const active = flights.current;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    // Stop moving labels when the user asks for less motion
    function clear() {
      active.forEach((label, animation) => {
        animation.cancel();
        label.remove();
      });
      active.clear();
    }
    function changed() {
      if (motion.matches) clear();
    }
    motion.addEventListener('change', changed);
    return () => {
      motion.removeEventListener('change', changed);
      clear();
    };
  }, []);
  useEffect(() => {
    const added = count - previous.current;
    previous.current = count;
    // Initial loads and smaller counts must never look like new answers
    if (
      added <= 0 ||
      !layer.current ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const active = flights.current;
    // Bound decorative work after a large reconnect snapshot
    for (let index = 0; index < Math.min(added, 100); index++) {
      if (active.size >= 200) {
        const [old, label] = active.entries().next().value!;
        old.cancel();
        label.remove();
        active.delete(old);
      }
      const label = document.createElement('span');
      label.textContent = '+1';
      label.className =
        'absolute left-1/2 -top-1/2 font-semibold text-success-ink';
      layer.current.append(label);
      const start = (Math.random() - 0.5) * 12;
      const drift = start + (Math.random() - 0.5) * 30;
      const animation = label.animate(
        [
          {transform: `translate(calc(-50% + ${start}px), 0)`, opacity: 1},
          {transform: `translate(calc(-50% + ${drift}px), -48px)`, opacity: 0},
        ],
        {
          duration: 3000,
          easing: 'cubic-bezier(0.2, 0.6, 0.35, 1)',
          fill: 'both',
        },
      );
      active.set(animation, label);
      // Remove each label on its own so quick updates can overlap
      animation.onfinish = () => {
        active.delete(animation);
        label.remove();
        animation.cancel();
      };
    }
  }, [count]);
  return (
    <span
      aria-label={t('Количество ответов: {value0}', {value0: count})}
      className="inline-flex items-center gap-1 text-xs text-muted"
    >
      <Check aria-hidden="true" className="size-4" />
      <span className="relative inline-block tabular-nums">
        {count}
        <span
          ref={layer}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 select-none"
        />
      </span>
    </span>
  );
}
