'use client';
import {useEffect, useRef} from 'react';
// A view lease expires after a crash, browser sessions still have no expiry
export function useQuestionPresence(
  link: string,
  question: string | null,
  run: string | null,
  onDenied: () => void,
) {
  const tab = useRef<string | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    tab.current ??= crypto.randomUUID();
    const path = `/api/vote/${link}/presence`;
    function report(clear = false) {
      const questionId =
        clear || document.visibilityState !== 'visible' ? null : question;
      void fetch(path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          tabId: tab.current,
          sequence: ++sequence.current,
          questionId,
          ...(run ? {runId: run} : {}),
        }),
        keepalive: true,
      })
        .then((response) => {
          if (response.status === 401 && !clear) onDenied();
        })
        .catch(() => {});
    }
    const visible = () => report();
    const leave = () => report(true);
    report();
    const timer = setInterval(() => report(), 10000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pagehide', leave);
      report(true);
    };
  }, [link, question, run, onDenied]);
}
