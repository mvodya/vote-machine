import {act, renderHook} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {useLive} from '../lib/use-live';
import {connectionSnapshot} from '../lib/connection-state';

it('shares streams, records heartbeats without reloading and cleans up on exit', async () => {
  const opened: Source[] = [];
  class Source extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor() {
      super();
      opened.push(this);
    }
  }
  vi.stubGlobal('EventSource', Source);
  const denied = vi.fn();
  const first = renderHook(() => useLive('/api/rooms/test/events', denied));
  const source = opened[0];
  act(() => {
    source.readyState = 1;
    source.dispatchEvent(
      new MessageEvent('ready', {
        data: JSON.stringify({apiId: 'a'.repeat(12), commit: 'dev'}),
      }),
    );
  });
  expect(first.result.current.connected).toBe(true);
  const version = first.result.current.version;
  act(() =>
    source.dispatchEvent(
      new MessageEvent('heartbeat', {
        data: JSON.stringify({apiId: 'a'.repeat(12), commit: 'dev'}),
      }),
    ),
  );
  expect(first.result.current.version).toBe(version);
  const second = renderHook(() => useLive('/api/rooms/test/events', denied));
  await act(async () => {
    await Promise.resolve();
  });
  expect(opened).toHaveLength(1);
  expect(second.result.current.connected).toBe(true);
  act(() => source.onerror?.());
  expect(connectionSnapshot()[0].status).toBe('disconnected');
  act(() => source.dispatchEvent(new MessageEvent('ready', {data: '{}'})));
  expect(connectionSnapshot()[0].reconnects).toBe(1);
  first.unmount();
  expect(source.close).not.toHaveBeenCalled();
  second.unmount();
  expect(source.close).toHaveBeenCalledOnce();
  expect(connectionSnapshot()).toEqual([]);
});
