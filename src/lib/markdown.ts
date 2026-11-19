// Helpers for rendering assistant answers (Markdown + LaTeX + citations).
// Everything here works on a copy used for rendering: the stored raw content is never altered.
import type { Element, Root as HastRoot } from "hast";
import type { PhrasingContent, Root as MdastRoot, Text } from "mdast";
import type { Plugin } from "unified";
import { visit, SKIP } from "unist-util-visit";

const FENCE_OPEN = /^[\s>]*(`{3,}|~{3,})/;

/**
 * Converts `\(..\)` to `$..$` and `\[..\]` to `$$..$$` outside fenced code blocks and inline
 * code spans, and turns a line made only of `$$..$$` into a display block. Returns a new string.
 *
 * Indented code blocks (4 spaces) are not detected: models use fenced blocks.
 */
export function normalizeMathDelimiters(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number } | null = null;

  const flushProse = () => {
    if (prose.length > 0) out.push(convertProse(prose.join("\n")));
    prose = [];
  };

  for (const line of lines) {
    if (fence) {
      out.push(line);
      const close = line.match(/^[\s>]*(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN);
    // A backtick fence's info string cannot contain backticks (CommonMark).
    if (open && !(open[1]![0] === "`" && line.slice(line.indexOf(open[1]!) + open[1]!.length).includes("`"))) {
      flushProse();
      out.push(line);
      fence = { char: open[1]![0]!, length: open[1]!.length };
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join("\n");
}

/** Index of the closing `\)` / `\]` (its backslash) or -1; never crosses a blank line. */
function findClose(text: string, from: number, close: string): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" && /^\n[ \t>]*\n/.test(text.slice(i, i + 64))) return -1;
    if (c !== "\\") continue;
    let j = i;
    while (text[j] === "\\") j++;
    if ((j - i) % 2 === 1 && text[j] === close) return j - 1;
    i = j - 1;
  }
  return -1;
}

function lineStartPrefix(out: string): string | null {
  const start = out.lastIndexOf("\n") + 1;
  const prefix = out.slice(start);
  return /^[\s>]*$/.test(prefix) ? prefix : null;
}

function convertProse(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "`") {
      let k = i;
      while (text[k] === "`") k++;
      const run = k - i;
      // Find a closing run of exactly the same length.
      let j = k;
      let end = -1;
      while (j < text.length) {
        const next = text.indexOf("`", j);
        if (next === -1) break;
        let m = next;
        while (text[m] === "`") m++;
        if (m - next === run) {
          end = m;
          break;
        }
        j = m;
      }
      if (end === -1) {
        out += text.slice(i, k);
        i = k;
      } else {
        out += text.slice(i, end);
        i = end;
      }
      continue;
    }
    if (c === "\\") {
      let j = i;
      while (text[j] === "\\") j++;
      const run = j - i;
      const next = text[j];
      if (run % 2 === 1 && (next === "(" || next === "[")) {
        const end = findClose(text, j + 1, next === "(" ? ")" : "]");
        const body = end === -1 ? "" : text.slice(j + 1, end).trim();
        if (end !== -1 && body !== "") {
          out += "\\".repeat(run - 1);
          const after = end + 2;
          if (next === "(") {
            out += `$${body}$`;
          } else {
            const prefix = run === 1 ? lineStartPrefix(out) : null;
            const lineEnd = text.indexOf("\n", after);
            const restOfLine = text.slice(after, lineEnd === -1 ? text.length : lineEnd);
            if (prefix !== null && restOfLine.trim() === "") {
              out += `$$\n${prefix}${body}\n${prefix}$$`;
            } else {
              out += `$$${body}$$`;
            }
          }
          i = after;
          continue;
        }
      }
      // Copy the backslashes and, if escaped, the next character verbatim.
      if (run % 2 === 1 && next !== undefined) {
        out += text.slice(i, j + 1);
        i = j + 1;
      } else {
        out += text.slice(i, j);
        i = j;
      }
      continue;
    }
    out += c;
    i++;
  }
  // `$$x$$` alone on a line is display math (remark-math would treat it as inline).
  return out
    .split("\n")
    .map((line) => {
      if (line.includes("`")) return line;
      const m = line.match(/^([\s>]*)\$\$(?!\$)(.+?)\$\$\s*$/);
      if (!m || m[2]!.includes("$$") || m[2]!.trim() === "") return line;
      const prefix = m[1]!;
      return `${prefix}$$\n${prefix}${m[2]!.trim()}\n${prefix}$$`;
    })
    .join("\n");
}

// ------------------------------------------------------------------ citations

/** `[1]`, `[1, 2]`, `[1;2]`, `[1-3]`. */
const CITATION = /\[(\d{1,4}(?:\s*[,;]\s*\d{1,4})*|\d{1,4}\s*[-–]\s*\d{1,4})\]/g;

export interface CitationOptions {
  /** Numbers that are valid citations of the message (sources with `cited` and that `n`). */
  valid: ReadonlySet<number>;
}

function citeNode(n: number): PhrasingContent {
  // Rendered by the `button` component of the Markdown renderer (Markdown never produces buttons:
  // raw HTML is shown as text).
  return {
    type: "text",
    value: String(n),
    data: { hName: "button", hProperties: { dataCite: String(n), type: "button" }, hChildren: [{ type: "text", value: String(n) }] },
  } as Text;
}

function splitCitations(value: string, valid: ReadonlySet<number>): PhrasingContent[] | null {
  CITATION.lastIndex = 0;
  const parts: PhrasingContent[] = [];
  let last = 0;
  let changed = false;
  for (const match of value.matchAll(CITATION)) {
    const tokens = match[1]!.split(/(\s*[,;\-–]\s*)/);
    const numbers = tokens.filter((_, i) => i % 2 === 0).map(Number);
    if (!numbers.some((n) => valid.has(n))) continue;
    changed = true;
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
    if (numbers.every((n) => valid.has(n)) && !/[-–]/.test(match[1]!)) {
      for (const n of numbers) parts.push(citeNode(n));
    } else {
      parts.push({ type: "text", value: "[" });
      tokens.forEach((token, i) => {
        if (i % 2 === 1) parts.push({ type: "text", value: token });
        else if (valid.has(Number(token))) parts.push(citeNode(Number(token)));
        else parts.push({ type: "text", value: token });
      });
      parts.push({ type: "text", value: "]" });
    }
    last = match.index + match[0].length;
  }
  if (!changed) return null;
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

/**
 * Remark plugin: turns valid `[n]` references in text into citation nodes. Code (inline and
 * fenced) and math are separate node types, so references inside them stay literal.
 */
export const remarkCitations: Plugin<[CitationOptions], MdastRoot> = (options) => (tree) => {
  if (options.valid.size === 0) return;
  visit(tree, "text", (node, index, parent) => {
    if (!parent || index === undefined || node.data?.hName) return;
    const parts = splitCitations(node.value, options.valid);
    if (!parts) return;
    parent.children.splice(index, 1, ...(parts as typeof parent.children));
    return [SKIP, index + parts.length];
  });
};

/** Rehype plugin: long display formulas scroll locally and can be reached with the keyboard. */
export const rehypeScrollableMath: Plugin<[], HastRoot> = () => (tree) => {
  visit(tree, "element", (node: Element) => {
    const cls = node.properties?.className;
    if (Array.isArray(cls) && cls.includes("katex-display")) {
      node.properties.tabIndex = 0;
      return SKIP;
    }
    return undefined;
  });
};
