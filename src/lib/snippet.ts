import { SNIPPET_MARK_END, SNIPPET_MARK_START } from "../api/types";

export interface SnippetPart {
  text: string;
  mark: boolean;
}

/**
 * Splits a search snippet into plain and highlighted parts. Markers are the
 * control characters U+0002 (start) and U+0003 (end); everything else is text
 * and is rendered as text (never as HTML). Unbalanced markers are tolerated.
 */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let mark = false;
  let buffer = "";
  const flush = () => {
    if (buffer) parts.push({ text: buffer, mark });
    buffer = "";
  };
  for (const char of snippet) {
    if (char === SNIPPET_MARK_START) {
      flush();
      mark = true;
    } else if (char === SNIPPET_MARK_END) {
      flush();
      mark = false;
    } else {
      buffer += char;
    }
  }
  flush();
  return parts;
}
