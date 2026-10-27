export interface StreamState {
  // Public process data, never an access key
  status: 'connecting' | 'connected' | 'disconnected' | 'denied';
  lastEvent: number;
  reconnects: number;
  apiId?: string;
  commit?: string;
}
const streams = new Map<string, StreamState>();
const listeners = new Set<() => void>();
const empty: StreamState[] = [];
let snapshot = empty;
// Share observations from the streams already used by the page
export function recordStream(path: string, state: StreamState | null) {
  if (state) streams.set(path, state);
  else streams.delete(path);
  snapshot = [...streams.values()];
  listeners.forEach((listener) => listener());
}
// Keep snapshot references stable for React subscriptions
export function connectionSnapshot() {
  return snapshot;
}
export function serverConnectionSnapshot() {
  return empty;
}
export function subscribeConnection(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
