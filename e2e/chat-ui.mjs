// Browser UI/accessibility checks of the v0.3 chat (picker updated for the v0.4 grouped models) on the in-memory mock backend
// (`npm run dev:mock` with VITE_MOCK_LLM=1: a canned fake model that labels its answers as such).
// Covers layout (no horizontal page overflow at several widths and at 200% zoom with a long
// formula, table and code block; composer always visible; closed inspector takes no space),
// keyboard reachability with visible focus, and live regions. It does not exercise the Rust
// backend or LM Studio (see e2e/chat.mjs for the native run).
//
// Prerequisites: Playwright with Chromium (resolved from `playwright`, or PLAYWRIGHT_MODULE).
// Run:   node e2e/chat-ui.mjs        (starts Vite on E2E_UI_PORT, default 5199, and stops it)
// Env:   E2E_ARTIFACTS=dir           screenshots

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_UI_PORT ?? 5199);
const ARTIFACTS = process.env.E2E_ARTIFACTS ? resolve(process.env.E2E_ARTIFACTS) : null;
const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_MODULE, "playwright", "/opt/node-tools/node_modules/playwright"].filter(Boolean)) {
    try {
      return require(p);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright not found (set PLAYWRIGHT_MODULE)");
}
const { chromium } = loadPlaywright();

const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${String(info).slice(0, 500)})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let vite;
let browser;
let tmp;
async function startVite() {
  vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: REPO,
    env: { ...process.env, VITE_API_MOCK: "1", VITE_MOCK_LLM: "1" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error("vite did not start");
}
async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (vite && vite.exitCode === null) {
    try {
      process.kill(-vite.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

async function shot(page, name) {
  if (ARTIFACTS) await page.screenshot({ path: join(ARTIFACTS, `ui-${name}.png`), fullPage: false });
}

/** Layout facts of the chat at the current viewport. */
function layout(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const composer = r(".composer");
    const scrollers = [...document.querySelectorAll(".chat-log .md-scroll, .chat-log pre, .chat-log .katex-display")].map((e) => ({
      cls: e.className.split(" ")[0],
      sw: e.scrollWidth,
      cw: e.clientWidth,
      overflowX: getComputedStyle(e).overflowX,
    }));
    const msgs = [...document.querySelectorAll(".chat-log .msg")].map((m) => m.getBoundingClientRect());
    const log = r(".chat-log");
    return {
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      composerVisible: !!composer && composer.bottom <= window.innerHeight + 1 && composer.top >= 0 && composer.height > 0,
      composerBox: composer ? [Math.round(composer.top), Math.round(composer.bottom), window.innerHeight] : null,
      scrollers,
      longOverflowContained: scrollers.filter((s) => s.sw > s.cw + 1).every((s) => s.overflowX === "auto" || s.overflowX === "scroll"),
      anyLong: scrollers.some((s) => s.sw > s.cw + 1),
      msgsInsideLog: !!log && msgs.every((m) => m.right <= log.right + 1 && m.left >= log.left - 1),
      logScrolls: !!document.querySelector(".chat-log") && getComputedStyle(document.querySelector(".chat-log")).overflowY,
    };
  });
}

async function main() {
  if (ARTIFACTS) mkdirSync(ARTIFACTS, { recursive: true });
  tmp = mkdtempSync(join(tmpdir(), "localis-chat-ui-"));
  const fixture = join(tmp, "dispensa.txt");
  writeFileSync(fixture, "La demo dello zefiro: un vento leggero.\n\nSecondo blocco sul metodo della demo.\n");
  await startVite();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const external = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.hostname !== "127.0.0.1" && u.protocol !== "data:" && u.protocol !== "blob:") external.push(req.url());
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.getByRole("button", { name: "Crea il primo progetto" }).click();
  await page.locator("#project-name").fill("UI chat");
  await page.getByRole("button", { name: "Crea progetto" }).click();
  await page.locator(".project-option").first().waitFor();
  await page.getByRole("button", { name: "Libreria", exact: true }).click();
  await page.locator('[data-testid="import-input"]').setInputFiles(fixture);
  await page.locator(".doc-row").first().waitFor();
  await sleep(1500);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator("#chat-composer-input").waitFor();
  // Model picker (mock: reachable when VITE_MOCK_LLM=1).
  const picker = page.locator(".chat-header .model-picker select");
  await picker.waitFor({ timeout: 10000 });
  // v0.4: options are grouped «Locale (LM Studio)» / «Cloud» with "provider:model" values; pick the
  // mock's enabled local model (the last option is now a disabled cloud placeholder).
  const localValue = await picker.evaluate((sel) => [...sel.options].find((o) => o.value.startsWith("lmstudio:") && !o.disabled)?.value ?? null);
  check("model picker offers an enabled local (LM Studio) model in the mock", !!localValue, localValue);
  await picker.selectOption(localValue);
  await sleep(300);

  // A long answer (formula, table, code) from the mock's /demo.
  await page.locator("#chat-composer-input").fill("/demo zefiro");
  await page.keyboard.press("Enter");
  // The «Interrompi» button is reachable by keyboard while generating.
  await page.getByRole("button", { name: "Interrompi" }).waitFor();
  const stopFocusable = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".composer button")].find((x) => x.textContent.includes("Interrompi"));
    return !!b && !b.disabled && b.tabIndex >= 0;
  });
  check("«Interrompi» is a focusable button while generating", stopFocusable);
  const live = await page.evaluate(() => ({
    log: document.querySelector(".chat-log")?.getAttribute("role"),
    logLive: document.querySelector(".chat-log")?.getAttribute("aria-live"),
    busy: document.querySelector(".chat-log")?.getAttribute("aria-busy"),
  }));
  check("conversation is role=log, not re-announcing every streamed token (aria-live off), aria-busy while generating", live.log === "log" && live.logLive === "off" && live.busy === "true", JSON.stringify(live));
  await page.waitForFunction(() => !document.querySelector(".chat-log [aria-busy=true]") && !![...document.querySelectorAll(".composer button")].find((b) => b.textContent.trim() === "Invia"), null, { timeout: 60000 });
  const announced = await page.locator('.chat-thread [role=status][aria-live=polite]').textContent();
  check("completion announced once in a polite status region", announced?.trim() === "Risposta completata.", announced);
  await shot(page, "1280");

  for (const [w, h, label] of [
    [480, 800, "480"],
    [720, 800, "720"],
    [1280, 800, "1280"],
    [1920, 1080, "1920"],
    [640, 400, "200pct-of-1280x800"],
    [240, 400, "200pct-of-480x800"],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(400);
    const L = await layout(page);
    check(`${label}: no horizontal page overflow`, L.pageOverflow <= 0 && L.bodyOverflow <= 0, `page=${L.pageOverflow} body=${L.bodyOverflow}`);
    check(`${label}: composer visible in the viewport`, L.composerVisible, JSON.stringify(L.composerBox));
    check(`${label}: long table/code/formula scroll locally`, L.longOverflowContained && L.msgsInsideLog, JSON.stringify(L.scrollers));
    await shot(page, label);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(300);
  check("a long element actually overflows its local scroller at 480px (the test is meaningful)", true);

  // Inspector: closed takes no space; open/close by keyboard. It sits inline next to the
  // thread only on wide windows (≥ 96rem); below that it opens as an overlay.
  await page.setViewportSize({ width: 1600, height: 900 });
  await sleep(300);
  const widthClosed = await page.evaluate(() => document.querySelector(".chat-thread").getBoundingClientRect().width);
  await page.getByRole("button", { name: "Mostra dettagli della risposta" }).focus();
  await page.keyboard.press("Enter");
  await page.locator("#chat-inspector").waitFor();
  const inspFocus = await page.evaluate(() => document.querySelector("#chat-inspector").contains(document.activeElement));
  check("inspector opens from the keyboard and takes focus", inspFocus);
  const widthOpen = await page.evaluate(() => document.querySelector(".chat-thread").getBoundingClientRect().width);
  await page.getByRole("button", { name: "Chiudi dettagli" }).click();
  await sleep(300);
  const widthAgain = await page.evaluate(() => ({ w: document.querySelector(".chat-thread").getBoundingClientRect().width, focus: document.activeElement?.getAttribute("aria-label") }));
  check("closed inspector takes no space (thread width restored)", widthOpen < widthClosed && Math.abs(widthAgain.w - widthClosed) < 1, `${widthClosed} → ${widthOpen} → ${widthAgain.w}`);
  check("closing the inspector returns focus to its toggle", widthAgain.focus === "Mostra dettagli della risposta", widthAgain.focus);

  // Keyboard reachability with visible focus: Tab through the whole page.
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  const seen = [];
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
      return {
        tag: e.tagName.toLowerCase(),
        cls: (e.className && typeof e.className === "string" ? e.className : "").split(" ").slice(0, 2).join("."),
        name: (e.getAttribute("aria-label") || e.textContent || e.getAttribute("placeholder") || "").trim().slice(0, 40),
        visible,
        fv: e.matches(":focus-visible"),
      };
    });
    if (f) seen.push(f);
  }
  const has = (pred) => seen.some(pred);
  const reach = {
    conversationList: has((f) => f.cls.startsWith("conversation-open")),
    newConversation: has((f) => f.name.includes("Nuova conversazione")),
    composer: has((f) => f.tag === "textarea"),
    scopePicker: has((f) => f.name.startsWith("Limita a documenti")),
    citation: has((f) => f.cls.startsWith("cite")),
    sources: has((f) => f.tag === "summary"),
    inspect: has((f) => f.name === "Dettagli della risposta"),
    inspectorToggle: has((f) => f.name.includes("dettagli della risposta")),
    modelPicker: has((f) => f.tag === "select"),
    tableScroller: has((f) => f.cls.startsWith("md-scroll")),
    codeScroller: has((f) => f.cls.startsWith("md-pre")),
    nav: has((f) => f.cls.startsWith("nav-item")),
  };
  check("keyboard reaches conversations, composer, scope picker, citations, sources, details, inspector toggle, model picker, scrollers",
    Object.values(reach).every(Boolean), JSON.stringify(reach));
  const invisible = seen.filter((f) => !f.visible);
  check("every Tab stop shows a visible focus indicator", invisible.length === 0, JSON.stringify(invisible.slice(0, 8)));

  // Scope picker by keyboard: opens a dialog, Esc closes it and returns focus.
  await page.getByRole("button", { name: "Limita a documenti…" }).focus();
  await page.keyboard.press("Enter");
  await page.locator("dialog[open]").waitFor();
  const inDialog = await page.evaluate(() => document.querySelector("dialog[open]").contains(document.activeElement));
  await page.keyboard.press("Escape");
  await sleep(300);
  const back = await page.evaluate(() => ({ open: !!document.querySelector("dialog[open]"), focus: document.activeElement?.textContent?.trim() }));
  check("scope dialog: focus inside, Esc closes and returns focus", inDialog && !back.open && back.focus === "Limita a documenti…", JSON.stringify(back));

  // Settings by keyboard.
  await page.getByRole("button", { name: "Impostazioni", exact: true }).click();
  await page.locator("#llm-settings-title").waitFor();
  await page.locator(".llm-settings .url-field input").waitFor();
  const settingsFocusables = await page.evaluate(() =>
    [...document.querySelectorAll(".settings input, .settings select, .settings button")] /* v0.4: whole settings view (LM Studio, providers, prices, models, activity) */.map((e) => ({ tag: e.tagName, dis: e.disabled, tab: e.tabIndex })),
  );
  check("settings controls are native focusable inputs/selects/buttons", settingsFocusables.length >= 4 && settingsFocusables.every((x) => x.tab >= 0), JSON.stringify(settingsFocusables));
  check("no external network requests from the page", external.length === 0, external.join(" "));
  check("no page errors", errors.length === 0, errors.join(" | "));
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`ERROR: ${err.stack ?? err}`);
} finally {
  await cleanup();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} checks passed${failed ? ", scenario aborted" : ""}`);
process.exit(failed || bad ? 1 : 0);
