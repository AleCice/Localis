import "katex/dist/katex.min.css";
import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import { normalizeMathDelimiters, rehypeScrollableMath, remarkCitations } from "../../lib/markdown";

export interface CitationInfo {
  /** Accessible label, e.g. «Fonte 1: «Dispensa.pdf», p. 3». */
  label: string;
  onOpen: () => void;
}

interface MarkdownProps {
  /** Raw Markdown (never modified: normalisation works on a copy). */
  content: string;
  /** Valid citations of this message by number; other `[n]` stay plain text. */
  citations?: ReadonlyMap<number, CitationInfo>;
}

const KATEX_OPTIONS = { throwOnError: false, trust: false, strict: "ignore" as const };

function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

const EMPTY = new Map<number, CitationInfo>();

/**
 * Markdown/GFM + LaTeX (KaTeX) renderer for chat messages. Raw HTML is shown as text (no
 * rehype-raw), links do not navigate (text + visible URL), images are not loaded.
 */
export const Markdown = memo(function Markdown({ content, citations = EMPTY }: MarkdownProps) {
  const source = useMemo(() => normalizeMathDelimiters(content), [content]);
  const valid = useMemo(() => new Set(citations.keys()), [citations]);
  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkGfm, [remarkMath, { singleDollarTextMath: true }], [remarkCitations, { valid }]],
    [valid],
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const text = textOf(children);
        const url = href ?? "";
        return (
          <span className="md-link">
            {children}
            {url && url !== text ? <span className="md-link-url"> ({url})</span> : null}
          </span>
        );
      },
      img: ({ alt }) => <span className="md-image">[immagine{alt ? `: ${alt}` : ""}]</span>,
      table: ({ children }) => (
        <div className="md-scroll" tabIndex={0} role="group" aria-label="Tabella">
          <table>{children}</table>
        </div>
      ),
      pre: ({ children }) => (
        <pre className="md-pre" tabIndex={0}>
          {children}
        </pre>
      ),
      button: ({ node }) => {
        const n = Number(node?.properties?.dataCite);
        const info = citations.get(n);
        if (!info) return <>{`[${n}]`}</>;
        return (
          <button type="button" className="cite" aria-label={info.label} title={info.label} onClick={info.onOpen}>
            {n}
          </button>
        );
      },
      input: ({ type, checked }) =>
        type === "checkbox" ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null,
    }),
    [citations],
  );

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[[rehypeKatex, KATEX_OPTIONS], rehypeScrollableMath]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
