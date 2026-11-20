// Browser UI/accessibility checks of the v0.4 cloud UI on the in-memory mock backend
// (`npm run dev:mock`: fake providers, nothing leaves the browser). Covers the «Provider cloud»
// settings (labels, password field cleared, key never in the DOM), the PRISM candidate list
// reordered by keyboard with focus following, the project «Uso del cloud» block and its
// confirmation, the per-question cloud confirmation dialog (initial focus on «Annulla», focus
// kept inside, Esc cancels, nothing stored), and no horizontal page overflow at 480/720/1280/1920
// and at 200% zoom. It does not exercise the Rust backend (see e2e/cloud.mjs).
//
// Prerequisites: Playwright with Chromium (resolved from `playwright`, or PLAYWRIGHT_MODULE).
// Run:   node e2e/cloud-ui.mjs       (starts Vite on E2E_UI_PORT, default 5198, and stops it)
// Env:   E2E_ARTIFACTS=dir           screenshots

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_UI_PORT ?? 5198);
const ARTIFACTS = process.env.E2E_ARTIFACTS ? resolve(process.env.E2E_ARTIFACTS) : null;
const SENTINEL = "sk-TEST-SENTINEL-ui-0123456789";
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
  const text = (typeof info === "string" ? info : JSON.stringify(info)).split(SENTINEL).join("[SENTINEL]");
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? `  (${text.slice(0, 500)})` : ""}`);
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
  if (ARTIFACTS) await page.screenshot({ path: join(ARTIFACTS, `cloud-ui-${name}.png`), fullPage: false });
}
const overflow = (page) => page.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));
async function sweep(page, label, extra) {
  for (const [w, h, name] of [[480, 800, "480"], [720, 800, "720"], [1280, 800, "1280"], [1920, 1080, "1920"], [640, 400, "200pct-1280"], [240, 400, "200pct-480"]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    const o = await overflow(page);
    const x = extra ? await page.evaluate(extra) : true;
    check(`${label} @${name}: no horizontal page overflow${extra ? " (dialog within viewport)" : ""}`, o.page <= 0 && o.body <= 0 && x === true, { ...o, x });
    await shot(page, `${label}-${name}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(200);
}
/** Controls without an accessible name inside a container. */
const unlabeled = (page, sel) =>
  page.evaluate((sel) => [...document.querySelectorAll(`${sel} input, ${sel} select, ${sel} textarea, ${sel} button`)].filter((e) => {
    if (e.type === "hidden") return false;
    const name = (e.labels?.[0]?.textContent || e.getAttribute("aria-label") || (e.getAttribute("aria-labelledby") && document.getElementById(e.getAttribute("aria-labelledby"))?.textContent) || (e.tagName === "BUTTON" ? e.textContent : "") || e.title || "").trim();
    return !name;
  }).map((e) => e.outerHTML.slice(0, 120)), sel);

async function main() {
  if (ARTIFACTS) mkdirSync(ARTIFACTS, { recursive: true });
  tmp = mkdtempSync(join(tmpdir(), "localis-cloud-ui-"));
  const fixture = join(tmp, "astrolabio.txt");
  writeFileSync(fixture, "L'astrolabio di ottone misura l'altezza degli astri.\n\nUn secondo blocco sull'astrolabio e le stelle.\n");
  await startVite();
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
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
  await page.locator("#project-name").fill("UI cloud");
  await page.getByRole("button", { name: "Crea progetto" }).click();
  await page.locator(".project-option").first().waitFor();
  await page.getByRole("button", { name: "Libreria", exact: true }).click();
  await page.locator('[data-testid="import-input"]').setInputFiles(fixture);
  await page.locator(".doc-row").first().waitFor();
  await sleep(1200);

  // ---- Settings: providers
  await page.locator("nav").getByRole("button", { name: "Impostazioni", exact: true }).click();
  await page.locator(".cloud-settings").waitFor();
  const key = page.locator("#api-key-openai");
  check("OpenAI key: password field with a visible label and a hint", (await key.getAttribute("type")) === "password" && (await page.getByLabel("Chiave API di OpenAI", { exact: true }).count()) === 1 && !!(await key.getAttribute("aria-describedby")));
  check("«Carica modelli» disabled without a key, with the reason", await page.locator("section.provider").filter({ has: page.getByRole("heading", { name: "OpenAI" }) }).getByRole("button", { name: "Carica modelli" }).isDisabled());
  await key.focus();
  await page.keyboard.type(SENTINEL);
  await page.keyboard.press("Enter");
  await page.getByText("Chiave salvata nel portachiavi").first().waitFor();
  const html = await page.content();
  check("key saved with Enter: field gone/cleared, key not in the DOM", !html.includes(SENTINEL) && (await page.locator("#api-key-openai").count()) === 0);
  check("save announced in a status region", (await page.locator('[role=status]').allTextContents()).some((t) => t.includes("Chiave di OpenAI salvata nel portachiavi.")));
  const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  check("key not in localStorage/sessionStorage", !ls.includes(SENTINEL));
  await page.locator("section.provider").filter({ has: page.getByRole("heading", { name: "OpenAI" }) }).getByRole("button", { name: "Carica modelli" }).click();
  await page.locator("section.provider .provider-model-id").first().waitFor();
  check("settings: every control has an accessible name", (await unlabeled(page, ".settings")).length === 0, await unlabeled(page, ".settings"));

  // ---- PRISM candidates reordered by keyboard
  // Controlled radios: the state changes after the save resolves, so click and wait.
  await page.getByRole("radio", { name: "Automatico" }).click();
  await page.waitForFunction(() => document.querySelector('input[name=routing][value=auto]')?.checked);
  await page.locator(".candidate-order, .models-settings .hint").first().waitFor();
  const addSel = page.getByLabel("Modello da aggiungere ai candidati");
  for (let i = 0; i < 2; i++) {
    const v = await addSel.evaluate((sel) => [...sel.options].find((o) => o.value && !o.disabled)?.value);
    await addSel.selectOption(v);
    await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
    await sleep(300);
  }
  const rows0 = await page.locator(".candidate-row .candidate-name").allTextContents();
  const firstDown = page.locator(".candidate-row").first().getByRole("button", { name: /^Sposta giù/ });
  await firstDown.focus();
  await page.keyboard.press("Enter");
  await sleep(500);
  const rows1 = await page.locator(".candidate-row .candidate-name").allTextContents();
  const focus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  check("candidate moved down with the keyboard; focus follows the moved item", rows0.length >= 2 && rows1[1] === rows0[0] && rows1[0] === rows0[1] && focus?.includes(rows0[0].split(" · ").slice(0, 2).join(" · ")), { rows0, rows1, focus });
  check("candidate list is an ordered list labelled by its heading", await page.locator("ol.candidate-order[aria-labelledby]").count() === 1);
  await sweep(page, "settings");
  await page.getByRole("radio", { name: "Manuale" }).click();
  await page.waitForFunction(() => document.querySelector('input[name=routing][value=manual]')?.checked);

  // ---- Project «Uso del cloud»
  await page.locator("nav").getByRole("button", { name: "Progetti", exact: true }).click();
  await page.locator(".project-cloud").waitFor();
  const localRadio = page.getByRole("radio", { name: /^Solo locale/ });
  const cloudRadio = page.getByRole("radio", { name: /^Consenti cloud/ });
  check("project: «Solo locale» checked by default; radios with names and descriptions", (await localRadio.isChecked()) && !(await cloudRadio.isChecked()) && !!(await cloudRadio.getAttribute("aria-describedby")));
  await cloudRadio.focus();
  await page.keyboard.press("Space");
  const pd = page.locator("dialog[open]");
  await pd.waitFor();
  const pdFocus = await page.evaluate(() => ({ inside: document.querySelector("dialog[open]").contains(document.activeElement), label: document.activeElement?.textContent.trim() }));
  await page.keyboard.press("Escape");
  await sleep(300);
  check("«Consenti cloud» opens a confirmation (focus inside); Esc cancels and keeps «Solo locale»", pdFocus.inside && (await page.locator("dialog[open]").count()) === 0 && (await localRadio.isChecked()), pdFocus);
  await cloudRadio.click();
  await page.locator("dialog[open]").getByRole("button", { name: "Consenti cloud" }).click();
  await sleep(300);
  check("confirmed: «Consenti cloud» checked", await cloudRadio.isChecked());
  check("project detail: every control has an accessible name", (await unlabeled(page, ".project-cloud")).length === 0, await unlabeled(page, ".project-cloud"));
  await sweep(page, "project");

  // ---- Chat: per-question confirmation
  await page.locator("nav").getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator("#chat-composer-input").waitFor();
  const picker = page.locator(".chat-header .model-picker select");
  const cloudValue = await picker.evaluate((sel) => [...sel.options].find((o) => o.value.startsWith("openai:") && !o.disabled)?.value ?? null);
  check("chat picker offers the loaded OpenAI models in the «Cloud» group", !!cloudValue && (await picker.locator(`optgroup[label="Cloud"] option[value="${cloudValue}"]`).count()) === 1, cloudValue);
  await picker.selectOption(cloudValue);
  await sleep(300);
  check("header shows the sober «Cloud: OpenAI · …» text", /^Cloud: OpenAI · /.test((await page.locator(".chat-header .model-state").textContent()) ?? ""));
  await page.locator("#chat-composer-input").fill("Cosa misura l'astrolabio?");
  await page.keyboard.press("Enter");
  const dlg = page.locator("dialog[open].cloud-send");
  await dlg.waitFor();
  const d = await page.evaluate(() => ({ focus: document.activeElement?.textContent.trim(), inside: document.querySelector("dialog[open]").contains(document.activeElement),
    labelled: !!document.querySelector("dialog[open]").getAttribute("aria-labelledby"), described: !!document.querySelector("dialog[open]").getAttribute("aria-describedby") }));
  check("cloud dialog: initial focus on «Annulla», labelled and described", d.focus === "Annulla" && d.inside && d.labelled && d.described, d);
  const trapped = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    // A native modal <dialog> makes the page inert; Chromium may pass focus to its own UI (activeElement = body),
    // which is not a page element. Only a focused page element outside the dialog counts as an escape.
    trapped.push(await page.evaluate(() => { const a = document.activeElement; return !a || a === document.body || (document.querySelector("dialog[open]")?.contains(a) ?? false) ? (a === document.body ? "body" : true) : a.outerHTML.slice(0, 80); }));
  }
  check("Tab never focuses a page element outside the modal dialog", trapped.every((x) => x === true || x === "body") && trapped.filter((x) => x === true).length >= 5, trapped);
  await sweep(page, "dialog", () => { const r = document.querySelector("dialog[open]")?.getBoundingClientRect(); return !!r && r.left >= -1 && r.right <= window.innerWidth + 1; });
  await page.keyboard.press("Escape");
  await sleep(400);
  const after = await page.evaluate(() => ({ open: !!document.querySelector("dialog[open]"), draft: document.querySelector("#chat-composer-input").value, focus: document.activeElement?.id,
    msgs: document.querySelectorAll(".chat-log .msg").length, status: [...document.querySelectorAll("[role=status]")].map((x) => x.textContent.trim()).filter(Boolean).join(" | ") }));
  check("Esc cancels: dialog closed, nothing in the log, question back in the composer (focused), announced", !after.open && after.msgs === 0 && after.draft === "Cosa misura l'astrolabio?" && after.focus === "chat-composer-input" && /Invio annullato: nulla è stato inviato a OpenAI/.test(after.status), after);
  await page.keyboard.press("Enter");
  await dlg.waitFor();
  await page.keyboard.press("Enter"); // focus is on «Annulla»: Enter cancels, it never sends
  await sleep(400);
  check("Enter on the initially focused button cancels (no accidental send)", (await page.locator(".chat-log .msg").count()) === 0 && (await page.locator("dialog[open]").count()) === 0);
  await page.keyboard.press("Enter");
  await dlg.waitFor();
  await dlg.getByRole("button", { name: /^Invia a OpenAI/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".chat-log .msg-assistant").length >= 1 && !document.querySelector(".chat-log [aria-busy=true]"), null, { timeout: 30000 });
  const modelLine = await page.locator(".chat-log .msg-assistant .msg-model").last().textContent();
  check("confirmed answer shows «OpenAI · model» under it", /^OpenAI · /.test(modelLine ?? ""), modelLine);
  check("no page errors; no external requests from the page", errors.length === 0 && external.length === 0, { errors, external });
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`ERROR: ${String(err?.stack ?? err).split(SENTINEL).join("[SENTINEL]")}`);
} finally {
  await cleanup();
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed${failed ? ", scenario aborted" : ""}`);
process.exit(failed || passed !== results.length ? 1 : 0);
