import {renderHook, act} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {useLive} from '../lib/use-live';
// Model only browser events, database guarantees have separate real tests
class FakeSource extends EventTarget {
  static instances: FakeSource[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    super();
    FakeSource.instances.push(this);
  }
}
it('shares a stream, refreshes on reconnect and clears views on access loss', () => {
  vi.stubGlobal('EventSource', FakeSource);
  const denied = vi.fn();
  const first = renderHook(() => useLive('/api/vote/one/events', denied));
  const second = renderHook(() => useLive('/api/vote/one/events', denied));
  expect(FakeSource.instances).toHaveLength(1);
  const source = FakeSource.instances[0];
  act(() => source.dispatchEvent(new Event('ready')));
  expect(first.result.current.connected).toBe(true);
  expect(second.result.current.version).toBe(1);
  act(() => source.onerror?.());
  expect(first.result.current.connected).toBe(false);
  act(() => source.dispatchEvent(new Event('ready')));
  expect(first.result.current.version).toBe(3);
  first.unmount();
  expect(source.close).not.toHaveBeenCalled();
  act(() => source.dispatchEvent(new Event('access')));
  expect(denied).toHaveBeenCalledTimes(1);
  second.unmount();
  expect(source.close).toHaveBeenCalled();
});
