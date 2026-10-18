import {fromMarkdown} from 'mdast-util-from-markdown';
import {assetId} from './assets';

interface SourceNode {
  // Parsed Markdown node kind
  type: string;
  // Text or code value
  value?: string;
  // Media URL for image nodes
  url?: string;
  // Label used by a reference-style link
  identifier?: string;
  // Media label
  alt?: string | null;
  // Nested parsed nodes
  children?: SourceNode[];
}
// Keep link behavior equal to the backend parser
export function safeMarkdownLink(url: string) {
  return (
    !/[\u0000-\u0020\u007f\\]/.test(url) &&
    (url === '' ||
      url.startsWith('#') ||
      (url.startsWith('/') && !url.startsWith('//')) ||
      /^(https?:\/\/|mailto:)/i.test(url))
  );
}
// Read image nodes without keeping code examples as real file references
export function markdownAssets(source: string): string[] {
  const found = new Set<string>();
  const root = fromMarkdown(source);
  const definitions = new Map<string, string>();
  // Read definitions before following image references
  function define(node: SourceNode) {
    if (
      node.type === 'definition' &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) define(child);
  }
  // Follow parsed nodes so fenced code and raw HTML remain text
  function visit(node: SourceNode) {
    const url =
      node.type === 'imageReference'
        ? definitions.get(node.identifier ?? '')
        : node.url;
    if (node.type === 'image' || node.type === 'imageReference') {
      const id = assetId(url);
      if (id) found.add(id);
    }
    for (const child of node.children ?? []) visit(child);
  }
  define(root);
  visit(root);
  return [...found];
}
// Show readable list labels without exposing managed URLs
export function markdownSummary(source: string) {
  // Collect visible text and media labels only
  function text(node: SourceNode): string {
    if (node.type === 'html') return '';
    if (node.type === 'image' || node.type === 'imageReference')
      return node.alt || 'Файл';
    if (node.value) return node.value;
    return (node.children ?? [])
      .map(text)
      .join(
        ['paragraph', 'heading', 'list', 'listItem', 'root'].includes(node.type)
          ? ' '
          : '',
      );
  }
  return text(fromMarkdown(source)).replace(/\s+/g, ' ').trim();
}
