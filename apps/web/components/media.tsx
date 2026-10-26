'use client';
import {useEffect, useState} from 'react';
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
  // Safe public metadata from the access-checked route
  const [asset, setAsset] = useState<Asset | null>(null);
  // A deleted or unavailable file has no public fallback URL
  const [failed, setFailed] = useState(false);
  const path = assetPath(viewer, id);
  useEffect(() => {
    const controller = new AbortController();
    // Each role reads its own scoped file route
    async function load() {
      try {
        const response = await fetch(`${path}/info`, {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
        });
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
    return () => controller.abort();
  }, [path, id]);
  if (failed)
    return (
      <span className="text-sm text-muted">
        {alt || 'Файл'} - файл недоступен
      </span>
    );
  if (!asset || asset.id !== id)
    return <span className="text-sm text-muted">Загружаем файл…</span>;
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
          className="block h-auto w-full"
          controls
          onError={() => setFailed(true)}
          playsInline
          preload="metadata"
          width={asset.width}
          height={asset.height}
          aria-label={alt || 'Видео'}
          src={path}
        >
          Ваш браузер не поддерживает это видео
        </video>
      ) : (
        // Private images use the viewer cookie and cannot go through a public optimizer
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="block h-auto w-full"
          src={path}
          alt={alt || 'Изображение'}
          width={asset.width}
          height={asset.height}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
