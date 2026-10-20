'use client';
import {useEffect, useRef} from 'react';

// Draw a light dot mesh without adding thousands of page elements
export function DotWaves() {
  // Canvas stays behind the form and never handles clicks
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const surface = element;
    const brush = context;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let frame = 0;
    let previous = 0;
    let phase = 0;
    let dark = false;
    let pointerX = 0;
    let pointerY = 0;
    let targetX = 0;
    let targetY = 0;

    // Keep the mesh sharp while limiting work on high density screens
    function resize() {
      const bounds = surface.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      brush.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint();
    }

    // Bend the mesh toward the pointer without moving any page controls
    function move(event: PointerEvent) {
      if (event.pointerType === 'touch' || motion.matches) return;
      const bounds = surface.getBoundingClientRect();
      targetX = Math.max(
        -1,
        Math.min(1, ((event.clientX - bounds.left) / width - 0.5) * 2),
      );
      targetY = Math.max(
        -1,
        Math.min(1, ((event.clientY - bounds.top) / height - 0.5) * 2),
      );
    }

    // Let the surface settle when the pointer leaves the page
    function resetPointer() {
      targetX = targetY = 0;
    }

    // Blend cool and warm dots along the moving wave crests
    function paint() {
      if (!width || !height) return;
      brush.clearRect(0, 0, width, height);
      const columns = width < 600 ? 48 : 78;
      const rows = width < 600 ? 34 : 44;
      const green = dark ? [106, 220, 176] : [40, 116, 98];
      const blue = dark ? [108, 173, 238] : [66, 125, 173];
      const gold = dark ? [227, 201, 133] : [161, 138, 72];
      for (let row = 0; row <= rows; row++) {
        const depth = row / rows;
        const perspective = 0.48 + depth * 0.75;
        for (let column = 0; column <= columns; column++) {
          const x = (column / columns - 0.5) * 3.8;
          const crest = Math.sin(x * 2.2 + depth * 3.6 - phase);
          const ripple = Math.cos(x * 3.4 - depth * 4.2 + phase * 0.7);
          const distance =
            (x - pointerX * 1.5) ** 2 + (depth - (pointerY + 1) / 2) ** 2;
          const bend = Math.exp(-distance * 2.4) * pointerY * 0.11;
          const px =
            width * (0.5 + x * 0.38 * perspective) + pointerX * 12 * depth;
          const py =
            height *
            (0.29 + depth * 0.46 + crest * 0.095 + ripple * 0.035 + bend);
          const edge = Math.sin((Math.PI * column) / columns) ** 0.6;
          const fade = Math.sin(Math.PI * (0.06 + depth * 0.88));
          const blend = (Math.sin(x * 1.6 + depth * 2 - phase * 0.45) + 1) / 2;
          const warm = Math.max(0, crest) ** 5 * 0.65;
          const color = green.map((channel, index) =>
            Math.round(
              (channel * (1 - blend) + blue[index] * blend) * (1 - warm) +
                gold[index] * warm,
            ),
          );
          brush.fillStyle = `rgba(${color.join(',')},${edge * fade * (dark ? 0.66 : 0.48)})`;
          brush.beginPath();
          brush.arc(
            px,
            py,
            (0.65 + depth * 1.05) * (1 + Math.max(0, crest) * 0.2),
            0,
            Math.PI * 2,
          );
          brush.fill();
        }
      }
    }

    // Stop work in hidden tabs and draw at most thirty frames each second
    function animate(now: number) {
      if (!document.hidden && now - previous >= 32) {
        phase += Math.min(now - previous, 64) * 0.00023;
        previous = now;
        pointerX += (targetX - pointerX) * 0.075;
        pointerY += (targetY - pointerY) * 0.075;
        paint();
      }
      frame = requestAnimationFrame(animate);
    }

    // Reduced motion keeps one still mesh with no pointer movement
    function start() {
      cancelAnimationFrame(frame);
      previous = performance.now();
      pointerX = pointerY = targetX = targetY = 0;
      paint();
      if (!motion.matches && !document.hidden)
        frame = requestAnimationFrame(animate);
    }

    // Match the page theme without starting the animation again
    function theme() {
      dark = document.documentElement.dataset.theme === 'dark';
      paint();
    }
    const size = new ResizeObserver(resize);
    const appearance = new MutationObserver(theme);
    size.observe(surface);
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    window.addEventListener('pointermove', move, {passive: true});
    document.documentElement.addEventListener('pointerleave', resetPointer);
    motion.addEventListener('change', start);
    document.addEventListener('visibilitychange', start);
    theme();
    resize();
    start();
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      appearance.disconnect();
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener(
        'pointerleave',
        resetPointer,
      );
      motion.removeEventListener('change', start);
      document.removeEventListener('visibilitychange', start);
    };
  }, []);
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden lg:right-[40%]"
      aria-hidden="true"
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_50%,var(--app-accent),transparent_70%)]" />
      <canvas
        ref={canvas}
        className="absolute inset-0 size-full opacity-70 lg:opacity-100"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-surface/30 via-transparent to-surface/70 lg:bg-gradient-to-r lg:from-transparent lg:via-transparent lg:to-surface" />
    </div>
  );
}
