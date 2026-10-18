import {render, screen} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {Markdown} from '../components/markdown';
import {
  markdownAssets,
  markdownSummary,
  safeMarkdownLink,
} from '../lib/markdown';

const room = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const id = 'b96c3a49-0198-4545-8dce-44b70c86494d';
it('renders safe Markdown with no raw HTML or executable URL attributes', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const {container} = render(
    <Markdown
      viewer={{roomId: room}}
      source={
        '# Title\n\n**Bold** and *italic*\n\n[Safe](https://example.com)\n\n[Bad](javascript:alert(1))\n\n![Remote](https://evil.test/track.png)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.test"></iframe>'
      }
    />,
  );
  expect(screen.getByRole('heading', {name: 'Title'})).toBeVisible();
  expect(container.querySelector('strong')).toHaveTextContent('Bold');
  expect(container.querySelector('em')).toHaveTextContent('italic');
  expect(screen.getByRole('link', {name: 'Safe'})).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  expect(screen.queryByRole('link', {name: 'Bad'})).not.toBeInTheDocument();
  expect(container.querySelector('script,iframe,img,object,embed')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses private role paths for a managed media reference', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      asset: {
        id,
        kind: 'video',
        mime: 'video/mp4',
        width: 2,
        height: 2,
        bytes: 100,
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const {container} = render(
    <Markdown
      viewer={{roomId: room, linkId: id}}
      source={`![Clip](asset:${id})`}
    />,
  );
  await vi.waitFor(() =>
    expect(container.querySelector('video')).toHaveAttribute(
      'src',
      `/api/vote/${id}/assets/${id}`,
    ),
  );
  expect(container.querySelector('video')).toHaveAttribute('controls');
  expect(fetcher).toHaveBeenCalledWith(
    `/api/vote/${id}/assets/${id}/info`,
    expect.objectContaining({cache: 'no-store'}),
  );
});
it('reads image nodes while ignoring fenced code and raw HTML', () => {
  const source = `![Photo](asset:${id})\n\n\`\`\`md\n![Example](asset:${room})\n\`\`\`\n\n<img src="asset:${room}">`;
  expect(markdownAssets(source)).toEqual([id]);
  expect(markdownAssets(`![Ref][media]\n\n[media]: asset:${id}`)).toEqual([id]);
  expect(markdownSummary(`**Question** ![Photo](asset:${id})`)).toBe(
    'Question Photo',
  );
  expect(markdownSummary('<script>private</script>')).toBe('');
});
it.each([
  'javascript:alert(1)',
  'data:text/html,x',
  '//evil.test',
  '/\\evil.test',
  'java\nscript:alert(1)',
  'file:///private',
])('blocks unsafe link %s', (url) => expect(safeMarkdownLink(url)).toBe(false));

it('keeps media mounted on parent edits and accepts a bounded display width', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      asset: {
        id,
        kind: 'image',
        mime: 'image/webp',
        width: 1000,
        height: 500,
        bytes: 100,
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const source = `![Photo](asset:${id} "width=320")`;
  const {rerender} = render(
    <Markdown viewer={{roomId: room}} source={source} />,
  );
  const photo = await screen.findByRole('img', {name: 'Photo'});
  expect(photo).toHaveStyle({width: '320px'});
  expect(photo).toHaveClass('object-left', 'ml-0');
  rerender(<Markdown viewer={{roomId: room}} source={source} />);
  expect(screen.getByRole('img')).toBe(photo);
  expect(fetcher).toHaveBeenCalledTimes(1);
  rerender(<Markdown viewer={{roomId: room}} source={`Updated ${source}`} />);
  expect(screen.getByRole('img')).toBe(photo);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
