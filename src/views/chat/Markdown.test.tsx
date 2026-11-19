import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Markdown, type CitationInfo } from "./Markdown";

function renderMd(content: string, citations?: Map<number, CitationInfo>) {
  const { container } = render(<Markdown content={content} citations={citations} />);
  return container;
}

describe("Markdown math", () => {
  it.each([
    ["$...$", "Inline $a^2+b^2$ fine.", false],
    ["$$...$$", "$$\n\\sum_{k=1}^n k\n$$", true],
    ["\\(...\\)", "Inline \\(a^2+b^2\\) fine.", false],
    ["\\[...\\]", "\\[\n\\int_0^1 x\\,dx\n\\]", true],
  ])("renders %s with KaTeX", (_name, source, display) => {
    const container = renderMd(source);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-display") !== null).toBe(display);
    expect(container.querySelector(".katex-error")).toBeNull();
    // MathML is part of the output (accessible formula).
    expect(container.querySelector("math")).not.toBeNull();
  });

  it("keeps $ and \\( literal inside inline code and fenced code", () => {
    const container = renderMd("Codice `$x$` e `\\(y\\)`.\n\n```\nprint('$z$ \\(w\\)')\n```");
    expect(container.querySelector(".katex")).toBeNull();
    const codes = [...container.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes).toContain("$x$");
    expect(codes).toContain("\\(y\\)");
    expect(codes.some((c) => c?.includes("print('$z$ \\(w\\)')"))).toBe(true);
  });

  it("does not alter the raw content passed in", () => {
    const message = { content: "Sia \\(x\\) e `\\(y\\)`." };
    const before = message.content;
    renderMd(message.content);
    expect(message.content).toBe(before);
  });

  it("renders invalid LaTeX without throwing and without trusting commands", () => {
    const container = renderMd("$\\href{javascript:alert(1)}{x}$ e $\\frac{1}{$");
    expect(container.querySelector("a, [href]")).toBeNull();
    // The source survives only as inert text (MathML annotation / error rendering).
    expect(container.querySelector(".katex-error")).not.toBeNull();
  });
});

describe("Markdown sanitisation", () => {
  it("shows raw HTML as text and never creates script, img or event handlers", () => {
    const container = renderMd('Prima <script>alert(1)</script> poi <img src=x onerror="alert(2)"> e <b>grassetto</b>.');
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("does not render links as navigable anchors and drops javascript: URLs", () => {
    const container = renderMd("[clic](javascript:alert(1)) e [sito](https://example.com) e ![img](x.png)");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.textContent).toContain("sito (https://example.com)");
    expect(container.textContent).toContain("[immagine: img]");
  });

  it("wraps tables, code and display math in locally scrollable, focusable regions", () => {
    const container = renderMd("| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n\n$$\nx\n$$");
    expect(container.querySelector(".md-scroll table")).not.toBeNull();
    expect(container.querySelector(".md-scroll")).toHaveAttribute("tabindex", "0");
    expect(container.querySelector("pre")).toHaveAttribute("tabindex", "0");
    expect(container.querySelector(".katex-display")).toHaveAttribute("tabindex", "0");
  });
});

describe("Markdown citations", () => {
  it("renders only valid citations as buttons, never inside code", async () => {
    const onOpen = vi.fn();
    const citations = new Map<number, CitationInfo>([
      [1, { label: "Fonte 1: «Dispensa.pdf», p. 3", onOpen }],
      [2, { label: "Fonte 2: «Appunti.md», blocco 4", onOpen: vi.fn() }],
    ]);
    const container = renderMd("Vero [1]. Falso [99]. Codice `[2]` e\n\n```\n[1]\n```", citations);

    const button = screen.getByRole("button", { name: "Fonte 1: «Dispensa.pdf», p. 3" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(container.textContent).toContain("[99]");
    expect(screen.queryByRole("button", { name: /Fonte 2/ })).toBeNull();
    expect([...container.querySelectorAll("code")].map((c) => c.textContent)).toContain("[2]");

    await userEvent.setup().click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("expands a valid range into one button per cited source, like the backend", () => {
    const citations = new Map<number, CitationInfo>([
      [1, { label: "Fonte 1", onOpen: vi.fn() }],
      [2, { label: "Fonte 2", onOpen: vi.fn() }],
      [3, { label: "Fonte 3", onOpen: vi.fn() }],
    ]);
    renderMd("Intervallo [1-3].", citations);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Fonte 2" })).toBeInTheDocument();
  });

  it("handles groups: valid numbers become buttons, others stay text", () => {
    const citations = new Map<number, CitationInfo>([
      [1, { label: "Fonte 1", onOpen: vi.fn() }],
      [3, { label: "Fonte 3", onOpen: vi.fn() }],
    ]);
    const container = renderMd("Vedi [1, 3] e [1, 7].", citations);
    expect(screen.getAllByRole("button", { name: "Fonte 1" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Fonte 3" })).toHaveLength(1);
    expect(container.textContent).toContain(", 7]");
  });

  it("keeps [n] plain text when the message has no valid citations", () => {
    const container = renderMd("Testo [1].");
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("[1]");
  });
});
