import '@testing-library/jest-dom/vitest';
import {cleanup} from '@testing-library/react';
import {afterEach, beforeEach, vi} from 'vitest';

// Layout and resize behavior are checked in real browsers
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
