import {act, render} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {AnswerCount} from '../components/answer-count';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, 'animate');
});

it('keeps separate increases, ignores the first count and cleans up finished or removed labels', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const animations: {
    cancel: ReturnType<typeof vi.fn>;
    onfinish?: () => void;
  }[] = [];
  const animate = vi.fn(() => {
    const animation = {cancel: vi.fn()};
    animations.push(animation);
    return animation as unknown as Animation;
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: animate,
  });
  const view = render(<AnswerCount count={10} />);
  expect(animations).toHaveLength(0);
  view.rerender(<AnswerCount count={13} />);
  expect(view.getAllByText('+1')).toHaveLength(3);
  view.rerender(<AnswerCount count={14} />);
  expect(view.getAllByText('+1')).toHaveLength(4);
  view.rerender(<AnswerCount count={0} />);
  expect(animations).toHaveLength(4);
  act(() => animations[0].onfinish!());
  expect(view.getAllByText('+1')).toHaveLength(3);
  view.unmount();
  expect(
    animations.every((animation) => animation.cancel.mock.calls.length === 1),
  ).toBe(true);
});
