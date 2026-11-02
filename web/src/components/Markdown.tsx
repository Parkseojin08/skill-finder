import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { relativeTarget } from '../lib/links.ts';
import { t } from '../i18n.ts';

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
        {t('[이미지: {0}]', alt || src)}
      </a>
    ) : (
      <span className="img-link">{t('[이미지: {0}]', alt || String(src ?? ''))}</span>
    ),
};

/**
 * `onRelativeLink`: a link into the skill's own folder opens there (the files tab) instead of a new tab on this
 * app's address, which only showed the start page (review 2026-11-02).
 */
export function Markdown({ text, onRelativeLink }: { text: string; onRelativeLink?: (path: string) => void }) {
  const parts = useMemo<Components>(
    () =>
      onRelativeLink
        ? {
            ...components,
            a: ({ href, children }) => {
              const path = relativeTarget(href);
              return path ? (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    onRelativeLink(path);
                  }}
                >
                  {children}
                </a>
              ) : (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
          }
        : components,
    [onRelativeLink],
  );
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={parts} skipHtml>
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
