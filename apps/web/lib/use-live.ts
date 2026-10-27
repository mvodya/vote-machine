'use client';
import {useEffect, useState} from 'react';
import {recordStream, type StreamState} from './connection-state';
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
      let opened = 0;
      let details: StreamState = {
        status: 'connecting',
        lastEvent: 0,
        reconnects: 0,
      };
      recordStream(path, details);
      // Heartbeats describe the actual SSE replica without reloading snapshots
      const observe = (event: Event) => {
        let body;
        try {
          body = JSON.parse((event as MessageEvent).data);
        } catch {}
        details = {
          ...details,
          status: 'connected',
          lastEvent: Date.now(),
          ...(typeof body?.apiId === 'string' &&
          /^[a-f0-9]{12}$/.test(body.apiId)
            ? {apiId: body.apiId}
            : {}),
          ...(typeof body?.commit === 'string' &&
          /^(dev|[a-f0-9]{7,40})$/i.test(body.commit)
            ? {commit: body.commit}
            : {}),
        };
        recordStream(path, details);
      };
      source.addEventListener('ready', (event) => {
        details = {...details, reconnects: Math.max(0, opened++)};
        observe(event);
      });
      source.addEventListener('change', observe);
      source.addEventListener('heartbeat', observe);
      const refresh = () =>
        shared.subscribers.forEach((item) => item.update(true));
      source.addEventListener('ready', refresh);
      source.addEventListener('change', refresh);
      source.addEventListener('access', () => {
        source.close();
        recordStream(path, {...details, status: 'denied'});
        shared.subscribers.forEach((item) => item.denied());
      });
      source.onerror = () => {
        recordStream(path, {...details, status: 'disconnected'});
        shared.subscribers.forEach((item) => item.update(false));
      };
    }
    const subscriber = {
      update: (connected: boolean) =>
        setState((old) => ({version: old.version + 1, connected})),
      denied: onDenied,
    };
    connection.subscribers.add(subscriber);
    if (connection.source.readyState === EventSource.OPEN)
      queueMicrotask(() => subscriber.update(true));
    const shared = connection;
    return () => {
      shared.subscribers.delete(subscriber);
      if (!shared.subscribers.size) {
        shared.source.close();
        connections.delete(path);
        recordStream(path, null);
      }
    };
  }, [path, onDenied]);
  return state;
}
