import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {QrSparks} from '../app/about/qr-sparks';
import {demoQuestionCycle} from '../app/about/cycle';

describe('landing animation snapshots', () => {
  it('keeps initial spark markup stable and scatters stars across all directions', () => {
    const html = renderToStaticMarkup(<QrSparks />);
    expect(renderToStaticMarkup(<QrSparks />)).toBe(html);
    const node = document.createElement('div');
    node.innerHTML = html;
    const stars = [...node.querySelectorAll('svg')];
    expect(stars).toHaveLength(48);
    const quadrants = new Set<string>();
    const delays = new Set<string>();
    for (const star of stars) {
      const x = star.style.getPropertyValue('--spark-x');
      const y = star.style.getPropertyValue('--spark-y');
      expect(x).toMatch(/^-?\d+\.\d{2}px$/);
      expect(y).toMatch(/^-?\d+\.\d{2}px$/);
      expect(star.style.width).toBe(star.style.height);
      quadrants.add(`${Number.parseFloat(x) > 0}/${Number.parseFloat(y) > 0}`);
      delays.add(star.style.animationDelay);
    }
    expect(quadrants.size).toBe(4);
    expect(delays.size).toBeGreaterThan(30);
  });

  it.each([
    [0, 'scheduled', 60000],
    [59999, 'scheduled', 60000],
    [60000, 'open', 120000],
    [119999, 'open', 120000],
    [120000, 'scheduled', 180000],
    [300000, 'open', 360000],
  ] as const)('uses the right minute at %i ms', (elapsed, state, end) => {
    const started = Date.parse('2026-01-15T10:00:00Z');
    const cycle = demoQuestionCycle(started, started + elapsed);
    expect(cycle.state).toBe(state);
    expect(Date.parse(cycle.endsAt)).toBe(started + end);
  });
});
