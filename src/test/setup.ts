import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

// jsdom does not implement modal dialogs: emulate the parts the UI relies on.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

// jsdom has no matchMedia. Tests can flip `prefers-color-scheme` via setSystemDark().
type Listener = (event: MediaQueryListEvent) => void;
const mediaLists = new Set<{ query: string; listeners: Set<Listener> }>();
let systemDark = false;

function evaluate(query: string): boolean {
  if (query.includes("prefers-color-scheme: dark")) return systemDark;
  return false;
}

window.matchMedia = (query: string): MediaQueryList => {
  const entry = { query, listeners: new Set<Listener>() };
  mediaLists.add(entry);
  return {
    get matches() {
      return evaluate(query);
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => entry.listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => entry.listeners.delete(listener),
    addListener: (listener: Listener) => entry.listeners.add(listener),
    removeListener: (listener: Listener) => entry.listeners.delete(listener),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
};

export function setSystemDark(value: boolean): void {
  systemDark = value;
  for (const entry of mediaLists) {
    if (!entry.query.includes("prefers-color-scheme")) continue;
    for (const listener of entry.listeners) listener({ matches: value, media: entry.query } as MediaQueryListEvent);
  }
}

afterEach(() => {
  systemDark = false;
  mediaLists.clear();
});
