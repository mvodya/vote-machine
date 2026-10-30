'use client';
import {useI18n} from './language-provider';
import {memo, useMemo} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {assetId, type MediaViewer} from '../lib/assets';
import {safeMarkdownLink} from '../lib/markdown';
import {Media} from './media';

// Translate the fallback without replacing working media players
function UnsupportedMedia() {
  const {t} = useI18n();
  return (
    <span className="text-muted">{t('Внешние файлы не поддерживаются')}</span>
  );
}
// Use the same safe renderer for editor previews and saved content
function MarkdownContent({
  source,
  viewer,
}: {
  // Stored Markdown source
  source: string;
  // Room and access role for private media
  viewer: MediaViewer;
}) {
  const components = useMemo(
    () => ({
      img: ({
        src,
        alt,
        title,
      }: {
        src?: string | Blob;
        alt?: string;
        title?: string;
      }) => {
        const id = assetId(src);
        const match = /^width=([1-9][0-9]{0,3})$/.exec(title ?? '');
        const width =
          match && Number(match[1]) <= 4096 ? Number(match[1]) : undefined;
        return id ? (
          <Media
            id={id}
            alt={alt ?? ''}
            viewer={{roomId: viewer.roomId, linkId: viewer.linkId}}
            displayWidth={width}
          />
        ) : (
          <UnsupportedMedia />
        );
      },
    }),
    [viewer.roomId, viewer.linkId],
  );
  return (
    <div className="min-w-0 text-sm leading-7 break-words [&_h1]:my-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:my-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-page [&_pre]:p-4 [&_code]:font-mono [&_code]:text-xs [&_a]:underline [&_hr]:my-5 [&_hr]:border-border [&_th]:border [&_th]:border-border [&_th]:p-2 [&_td]:border [&_td]:border-border [&_td]:p-2">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) =>
          key === 'src'
            ? assetId(url)
              ? url
              : ''
            : safeMarkdownLink(url)
              ? url
              : ''
        }
        components={{
          ...components,
          a: ({href, children}) =>
            href && safeMarkdownLink(href) ? (
              <a
                href={href}
                {...(/^https?:/i.test(href)
                  ? {target: '_blank', rel: 'noopener noreferrer'}
                  : {})}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({children}) => (
            <div className="my-3 max-w-full overflow-x-auto">
              <table className="border-collapse">{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
// Keep other fields from rebuilding unchanged media previews
export const Markdown = memo(
  MarkdownContent,
  (before, after) =>
    before.source === after.source &&
    before.viewer.roomId === after.viewer.roomId &&
    before.viewer.linkId === after.viewer.linkId,
);
