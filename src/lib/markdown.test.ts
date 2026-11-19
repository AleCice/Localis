import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./markdown";

describe("normalizeMathDelimiters", () => {
  it("converts \\( \\) to $ and \\[ \\] on their own lines to a display block", () => {
    expect(normalizeMathDelimiters("Sia \\(x^2\\) positivo.")).toBe("Sia $x^2$ positivo.");
    expect(normalizeMathDelimiters("Quindi\n\\[\n\\int_0^1 f\n\\]\nfine")).toBe("Quindi\n$$\n\\int_0^1 f\n$$\nfine");
    expect(normalizeMathDelimiters("in linea \\[a+b\\] qui")).toBe("in linea $$a+b$$ qui");
  });

  it("turns a line made only of $$...$$ into a display block", () => {
    expect(normalizeMathDelimiters("$$E = mc^2$$")).toBe("$$\nE = mc^2\n$$");
  });

  it("leaves inline code and fenced code untouched", () => {
    const inline = "Usa `\\(x\\)` e `$y$` così.";
    expect(normalizeMathDelimiters(inline)).toBe(inline);
    const fenced = "```latex\n\\(a\\) e \\[b\\]\n$$c$$\n```\nfuori \\(d\\)";
    expect(normalizeMathDelimiters(fenced)).toBe("```latex\n\\(a\\) e \\[b\\]\n$$c$$\n```\nfuori $d$");
    const tilde = "~~~\n\\(a\\)\n~~~";
    expect(normalizeMathDelimiters(tilde)).toBe(tilde);
  });

  it("does not treat escaped backslashes (\\\\[2pt]) as delimiters", () => {
    const matrix = "$$\n\\begin{pmatrix} a \\\\[2pt] b \\end{pmatrix}\n$$";
    expect(normalizeMathDelimiters(matrix)).toBe(matrix);
  });

  it("keeps unmatched delimiters and never crosses a blank line", () => {
    expect(normalizeMathDelimiters("aperta \\( senza chiusura")).toBe("aperta \\( senza chiusura");
    expect(normalizeMathDelimiters("\\(a\n\nb\\)")).toBe("\\(a\n\nb\\)");
  });

  it("returns a new string and leaves its input unchanged", () => {
    const raw = "Formula \\(x\\) e `\\(y\\)`";
    const copy = raw.slice();
    const out = normalizeMathDelimiters(raw);
    expect(raw).toBe(copy);
    expect(out).not.toBe(raw);
  });
});
