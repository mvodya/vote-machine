'use client';
import {useI18n} from './language-provider';
import {useEffect, useRef, useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {Spinner} from './ui/loading';
import {reportMediaFailure} from '../lib/media-events';
import {assetPath, isAsset, type Asset, type MediaViewer} from '../lib/assets';
// Read private metadata before choosing an image or video element
export function Media({
  id,
  alt,
  viewer,
  displayWidth,
}: {
  // File selected by a parsed managed reference
  id: string;
  // Label written in Markdown
  alt: string;
  // Current room and access role
  viewer: MediaViewer;
  // Optional Markdown display width in pixels
  displayWidth?: number;
}) {
  const {t} = useI18n();
  // Safe public metadata from the access-checked route
  const [asset, setAsset] = useState<Asset | null>(null);
  // A deleted or unavailable file has no public fallback URL
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);
  const generation = useRef(0);
  const source = useRef('');
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const path = assetPath(viewer, id);
  useEffect(() => {
    const controller = new AbortController();
    const ownGeneration = ++generation.current;
    if (source.current !== path) {
      source.current = path;
      retries.current = 0;
    }
    // Each role reads its own scoped file route
    async function load() {
      try {
        let response: Response | undefined;
        // A short burst or storage restart must not leave a permanent placeholder
        for (let retry = 0; retry < 3; retry++) {
          response = await fetch(`${path}/info`, {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(12000),
            ]),
          });
          if (![429, 503].includes(response.status) || retry === 2) break;
          reportMediaFailure(response.status);
          const wait = Math.min(
            4000,
            Math.max(
              300,
              Number(response.headers.get('retry-after') || 0) * 1000,
            ),
          );
          await response.arrayBuffer();
          await new Promise((resolve) => setTimeout(resolve, wait));
          if (controller.signal.aborted) return;
        }
        if (!response) throw new Error('Media unavailable');
        if (!response.ok) reportMediaFailure(response.status);
        if (!response.ok) throw new Error('Media unavailable');
        const body = await response.json();
        if (!isAsset(body.asset) || body.asset.id !== id)
          throw new Error('Invalid media');
        if (!controller.signal.aborted) {
          setAsset(body.asset);
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    void load();
    return () => {
      generation.current = ownGeneration + 1;
      controller.abort();
      clearTimeout(retryTimer.current);
    };
  }, [path, id, attempt]);
  // Keep explicit retry available after temporary failures
  function retry() {
    setFailed(false);
    setReason('');
    setAttempt((value) => value + 1);
  }
  // Check HTTP before blaming a codec, browsers also use code 4 for failed reads
  async function videoFailed(element: HTMLVideoElement) {
    const current = generation.current;
    const code = element.error?.code;
    let status = 0;
    try {
      const response = await fetch(path, {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
      status = response.status;
    } catch {}
    if (current !== generation.current) return;
    reportMediaFailure(status, code);
    if (
      (!status ||
        status === 429 ||
        status === 503 ||
        code === 2 ||
        (code === 4 && retries.current === 0)) &&
      retries.current < 2
    ) {
      retryTimer.current = setTimeout(
        () => {
          retries.current++;
          retry();
        },
        1000 * (retries.current + 1),
      );
      return;
    }
    setReason(
      status === 200 && (code === 3 || code === 4)
        ? 'Браузер не поддерживает формат видео'
        : 'Не удалось загрузить видео',
    );
    setFailed(true);
  }
  if (failed)
    return (
      <span className="text-sm text-muted">
        {(reason && t(reason)) ||
          t('{value0} - файл недоступен', {value0: alt || t('Файл')})}
        <button
          type="button"
          onClick={retry}
          className="ml-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t('Повторить загрузку')}
        </button>
      </span>
    );
  if (!asset || asset.id !== id)
    return <Spinner label={t('Загружаем файл…')} />;
  // Scale both sides together so rounded corners touch the actual picture
  const width = Math.min(
    displayWidth ?? asset.width,
    (480 * asset.width) / asset.height,
  );
  return (
    <span
      className={`my-3 block min-w-0 max-w-full overflow-hidden rounded-xl text-left ${asset.kind === 'video' ? 'border border-border bg-panel' : ''}`}
      style={{width: `min(100%, ${width}px)`}}
    >
      {asset.kind === 'video' ? (
        <video
          key={attempt}
          className="block h-auto w-full"
          controls
          onError={(event) => void videoFailed(event.currentTarget)}
          playsInline
          preload="metadata"
          width={asset.width}
          height={asset.height}
          aria-label={alt || t('Видео')}
          src={attempt ? `${path}?retry=${attempt}` : path}
        >
          {t('Ваш браузер не поддерживает это видео')}
        </video>
      ) : (
        // Private images use the viewer cookie and cannot go through a public optimizer
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="block h-auto w-full"
          src={path}
          alt={alt || t('Изображение')}
          width={asset.width}
          height={asset.height}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
