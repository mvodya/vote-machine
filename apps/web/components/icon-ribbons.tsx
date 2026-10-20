'use client';
import {useEffect, useRef} from 'react';
import {
  BadgeCheck,
  ChartColumn,
  ChartPie,
  CheckCheck,
  CircleCheck,
  ClipboardList,
  ListChecks,
  MessageSquare,
  MousePointer2,
  Radio,
  Timer,
  Users,
  Vote,
} from 'lucide-react';

const icons = [
  Vote,
  ListChecks,
  ChartColumn,
  Users,
  CircleCheck,
  MessageSquare,
  ChartPie,
  ClipboardList,
  BadgeCheck,
  Radio,
  Timer,
  CheckCheck,
  MousePointer2,
];

// Move five icon bands above the existing dot background
export function IconRibbons() {
  // Each band owns an independent compositor animation
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bands = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-ribbon]') ?? [],
    );
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const speeds = bands.map(() => 1);
    const boosts = bands.map(() => 1);
    let frame = 0;
    let previous = 0;
    let lastX: number | undefined;
    let lastY: number | undefined;
    const animations = bands.map((band, index) =>
      band.firstElementChild!.animate(
        [
          {transform: 'translate3d(0, 0, 0)'},
          {transform: 'translate3d(0, 0, 0)'},
        ],
        {
          duration: 48000 + index * 6500,
          iterations: Infinity,
          easing: 'linear',
          direction: index % 2 ? 'reverse' : 'normal',
        },
      ),
    );

    // One full repeat uses the same whole-pixel width as both icon copies
    function resize() {
      bands.forEach((band, index) => {
        const track = band.firstElementChild as HTMLElement;
        const width = Math.ceil(parseFloat(getComputedStyle(band).width));
        track.style.width = `${width * 2}px`;
        for (const copy of Array.from(track.children))
          (copy as HTMLElement).style.width = `${width}px`;
        (animations[index].effect as KeyframeEffect).setKeyframes([
          {transform: 'translate3d(0, 0, 0)'},
          {transform: `translate3d(-${width}px, 0, 0)`},
        ]);
      });
    }
    const size = new ResizeObserver(resize);
    bands.forEach((band) => size.observe(band));
    resize();

    // Ease back to the normal speed after the pointer brushes a band
    function settle(now: number) {
      const step = Math.min((now - previous) / 16.67, 3);
      previous = now;
      let moving = false;
      animations.forEach((animation, index) => {
        boosts[index] = 1 + (boosts[index] - 1) * Math.pow(0.97, step);
        speeds[index] +=
          (boosts[index] - speeds[index]) * (1 - Math.pow(0.88, step));
        if (Math.abs(speeds[index] - 1) < 0.01 && boosts[index] < 1.01)
          speeds[index] = boosts[index] = 1;
        else moving = true;
        animation.updatePlaybackRate(speeds[index]);
      });
      frame = moving ? requestAnimationFrame(settle) : 0;
    }

    // Check the rotated band itself, not its larger screen rectangle
    function move(event: PointerEvent) {
      if (event.pointerType === 'touch' || motion.matches || document.hidden)
        return;
      const distance =
        lastX === undefined
          ? 0
          : Math.hypot(event.clientX - lastX, event.clientY - lastY!);
      lastX = event.clientX;
      lastY = event.clientY;
      if (!distance) return;
      // Clipped parts outside the illustration are not real contact
      const area = root.current!.getBoundingClientRect();
      if (
        event.clientX < area.left ||
        event.clientX > area.right ||
        event.clientY < area.top ||
        event.clientY > area.bottom
      )
        return;
      const angle = -Math.PI / 6;
      bands.forEach((band, index) => {
        const box = band.getBoundingClientRect();
        const x = event.clientX - box.left - box.width / 2;
        const y = event.clientY - box.top - box.height / 2;
        const localX = Math.cos(angle) * x + Math.sin(angle) * y;
        const localY = -Math.sin(angle) * x + Math.cos(angle) * y;
        if (
          Math.abs(localX) <= band.offsetWidth / 2 &&
          Math.abs(localY) <= band.offsetHeight / 2
        )
          boosts[index] = Math.min(5, boosts[index] + distance * 0.035);
      });
      if (!frame) {
        previous = performance.now();
        frame = requestAnimationFrame(settle);
      }
    }

    // Pause decorative motion in hidden tabs and for reduced motion
    function sync() {
      cancelAnimationFrame(frame);
      frame = 0;
      lastX = lastY = undefined;
      animations.forEach((animation, index) => {
        speeds[index] = boosts[index] = 1;
        animation.updatePlaybackRate(1);
        if (motion.matches || document.hidden) animation.pause();
        else animation.play();
      });
    }
    sync();
    window.addEventListener('pointermove', move, {passive: true});
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      animations.forEach((animation) => animation.cancel());
      window.removeEventListener('pointermove', move);
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);
  return (
    <div
      ref={root}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_8%,black_23%,black_65%,transparent_86%)] lg:right-[40%]"
    >
      <div className="absolute top-[20%] -left-[40%] flex w-[180%] -rotate-30 flex-col gap-5 lg:top-[23%] lg:gap-6">
        {Array.from({length: 5}, (_, row) => (
          <div
            key={row}
            data-ribbon={row}
            className="h-16 shrink-0 overflow-hidden border-y border-primary/10 bg-panel/45 text-primary/50 shadow-xs backdrop-blur-sm lg:h-18"
          >
            <div className="flex h-full w-[200%] will-change-transform">
              {[0, 1].map((copy) => (
                <div
                  key={copy}
                  className="flex h-full w-1/2 shrink-0 items-center justify-around"
                >
                  {icons.map((Icon, index) => {
                    const Mark =
                      icons[(index + row * 3) % icons.length] ?? Icon;
                    return (
                      <Mark
                        key={index}
                        className="size-5 shrink-0 lg:size-7"
                        strokeWidth={1.4}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
