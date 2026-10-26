import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Raw HTML is never rendered (no rehype-raw). Remote images are not loaded: they become links.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && /^https?:\/\//.test(src) ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className="img-link">
        [이미지: {alt || src}]
      </a>
    ) : (
      <span className="img-link">[이미지: {alt || String(src ?? '')}]</span>
    ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Splits a leading `---` frontmatter block off the body. */
export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const m = md.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  return m ? { frontmatter: m[1], body: m[2] } : { frontmatter: null, body: md };
}
