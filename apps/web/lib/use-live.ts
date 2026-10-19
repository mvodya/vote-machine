'use client';
import {useEffect, useState} from 'react';
interface Subscriber {
  // Refresh snapshots and clear denied views
  update: (connected: boolean) => void;
  denied: () => void;
}
interface Connection {
  // Share one stream between views of the same access role
  source: EventSource;
  subscribers: Set<Subscriber>;
}
const connections = new Map<string, Connection>();
// Reconnect always requests a new snapshot because notifications can be missed
export function useLive(path: string | null, onDenied: () => void) {
  const [state, setState] = useState({version: 0, connected: false});
  useEffect(() => {
    if (!path || typeof EventSource === 'undefined') return;
    let connection = connections.get(path);
    if (!connection) {
      const source = new EventSource(path);
      connection = {source, subscribers: new Set()};
      connections.set(path, connection);
      const shared = connection;
      const refresh = () =>
        shared.subscribers.forEach((item) => item.update(true));
      source.addEventListener('ready', refresh);
      source.addEventListener('change', refresh);
      source.addEventListener('access', () => {
        source.close();
        shared.subscribers.forEach((item) => item.denied());
      });
      source.onerror = () =>
        shared.subscribers.forEach((item) => item.update(false));
    }
    const subscriber = {
      update: (connected: boolean) =>
        setState((old) => ({version: old.version + 1, connected})),
      denied: onDenied,
    };
    connection.subscribers.add(subscriber);
    const shared = connection;
    return () => {
      shared.subscribers.delete(subscriber);
      if (!shared.subscribers.size) {
        shared.source.close();
        connections.delete(path);
      }
    };
  }, [path, onDenied]);
  return state;
}
