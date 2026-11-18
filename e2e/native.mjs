// Native end-to-end test: drives the real Localis desktop app (WebKitGTK webview +
// real SQLite) through tauri-driver / WebKitWebDriver using the W3C WebDriver protocol.
// Plain Node >= 22, no dependencies.
//
// Prerequisites (Linux):
//   - a debug build of the app:   npm run tauri build -- --debug --no-bundle
//   - WebKitWebDriver on PATH (Debian/Ubuntu package: webkit2gtk-driver)
//   - tauri-driver:                cargo install tauri-driver --locked
//   - xvfb-run when there is no $DISPLAY (headless machines and containers)
//
// Run:
//   node e2e/native.mjs
//
// Environment (all optional):
//   LOCALIS_BIN        app binary            (default: <repo>/target/debug/localis)
//   TAURI_DRIVER       tauri-driver binary   (default: tauri-driver on PATH, then ~/.cargo/bin)
//   E2E_PORT           tauri-driver port     (default: 4444; native driver uses port + 1)
//   E2E_ARTIFACTS      directory for screenshots and the driver log (default: none)
//   E2E_KEEP=1         keep the temporary data directory for inspection
//
// The script creates its own temporary directory (under $TMPDIR), points XDG_DATA_HOME / XDG_CONFIG_HOME /
// XDG_CACHE_HOME / HOME at it (so the database and the webview's localStorage never touch
// real user data), and removes it at the end unless E2E_KEEP=1.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync, createWriteStream } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.LOCALIS_BIN ?? join(REPO, "target/debug/localis");
const PORT = Number(process.env.E2E_PORT ?? 4444);
const ARTIFACTS = process.env.E2E_ARTIFACTS ? resolve(process.env.E2E_ARTIFACTS) : null;
const IDENTIFIER = "app.localis.desktop";
const PROJECT_NAME = "Tesi di laurea E2E";

function findDriver() {
  if (process.env.TAURI_DRIVER) return process.env.TAURI_DRIVER;
  const which = spawnSync("sh", ["-c", "command -v tauri-driver"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return join(homedir(), ".cargo/bin/tauri-driver");
}

// ---------- tiny assertion / reporting helpers ----------
const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- W3C WebDriver client ----------
const BASE = `http://127.0.0.1:${PORT}`;
async function wd(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.value && json.value.error)) {
    const err = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
    err.wd = json.value;
    throw err;
  }
  return json.value;
}

const ELEMENT = "element-6066-11e4-a07c-4f15c3e2a2d1";
// W3C key, with a fallback for drivers that still use the legacy key.
const ref = (v) => v[ELEMENT] ?? v.ELEMENT ?? Object.values(v)[0];

class Session {
  static async start() {
    const value = await wd("POST", "/session", {
      capabilities: {
        alwaysMatch: { browserName: "wry", "tauri:options": { application: BIN } },
      },
    });
    const s = new Session();
    s.id = value.sessionId;
    return s;
  }
  p(path) {
    return `/session/${this.id}${path}`;
  }
  async quit() {
    await wd("DELETE", this.p(""));
  }
  exec(script, args = []) {
    return wd("POST", this.p("/execute/sync"), { script, args });
  }
  async find(css) {
    const v = await wd("POST", this.p("/element"), { using: "css selector", value: css });
    return ref(v);
  }
  async findAll(css) {
    const v = await wd("POST", this.p("/elements"), { using: "css selector", value: css });
    return v.map(ref);
  }
  async findByText(tag, text) {
    const v = await wd("POST", this.p("/element"), {
      using: "xpath",
      value: `//${tag}[normalize-space(.)=${JSON.stringify(text)}]`,
    });
    return ref(v);
  }
  click(el) {
    return wd("POST", this.p(`/element/${el}/click`), {});
  }
  type(el, text) {
    return wd("POST", this.p(`/element/${el}/value`), { text });
  }
  async keys(...keys) {
    // Key actions on the focused element.
    const actions = [];
    for (const k of keys) actions.push({ type: "keyDown", value: k }, { type: "keyUp", value: k });
    await wd("POST", this.p("/actions"), { actions: [{ type: "key", id: "kbd", actions }] });
    await wd("DELETE", this.p("/actions"));
  }
  async screenshot(name) {
    if (!ARTIFACTS) return;
    const b64 = await wd("GET", this.p("/screenshot"));
    writeFileSync(join(ARTIFACTS, `${name}.png`), Buffer.from(b64, "base64"));
  }
  /** Polls `fn` (an expression evaluated in the page) until it returns truthy. */
  async waitFor(expr, desc, timeout = 10000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.exec(`return (${expr});`);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(100);
    }
    throw new Error(`timeout waiting for: ${desc} (last: ${JSON.stringify(last)})`);
  }
  text(css) {
    return this.exec(`const e = document.querySelector(arguments[0]); return e ? e.textContent.trim() : null;`, [css]);
  }
  projectNames() {
    return this.exec(`return [...document.querySelectorAll('.project-option')].map(e => e.textContent.trim());`);
  }
}

// ---------- process management ----------
let driver;
let dataRoot;
const SNAPSHOT_EXCLUDES = new Set(["node_modules", "target", ".git", "dist"]);

function repoSnapshot(dir = REPO, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (dir === REPO && SNAPSHOT_EXCLUDES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) repoSnapshot(full, out);
    else out.set(full, statSync(full).mtimeMs);
  }
  return out;
}

async function startDriver() {
  dataRoot = mkdtempSync(join(tmpdir(), "localis-e2e-"));
  const env = {
    ...process.env,
    HOME: join(dataRoot, "home"),
    XDG_DATA_HOME: join(dataRoot, "data"),
    XDG_CONFIG_HOME: join(dataRoot, "config"),
    XDG_CACHE_HOME: join(dataRoot, "cache"),
    XDG_STATE_HOME: join(dataRoot, "state"),
    // xvfb-run keeps its auth file under TMPDIR: keep it inside the temporary directory too.
    TMPDIR: dataRoot,
    // Software rendering: avoids GPU/compositing problems under Xvfb.
    WEBKIT_DISABLE_COMPOSITING_MODE: process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? "1",
  };
  for (const d of ["home", "data", "config", "cache", "state"]) mkdirSync(join(dataRoot, d));
  const driverBin = findDriver();
  const args = ["--port", String(PORT), "--native-port", String(PORT + 1)];
  const [cmd, cmdArgs] = process.env.DISPLAY ? [driverBin, args] : ["xvfb-run", ["-a", driverBin, ...args]];
  driver = spawn(cmd, cmdArgs, { env, cwd: dataRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = ARTIFACTS ? createWriteStream(join(ARTIFACTS, "driver.log")) : null;
  driver.stdout.on("data", (d) => log?.write(d));
  driver.stderr.on("data", (d) => log?.write(d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/status`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`tauri-driver did not start on port ${PORT}`);
}

async function stopDriver() {
  if (!driver || driver.exitCode !== null || driver.signalCode !== null) return;
  const exited = new Promise((r) => driver.once("exit", r));
  try {
    process.kill(-driver.pid, "SIGTERM");
  } catch {
    return; /* already gone */
  }
  await Promise.race([exited, sleep(5000)]);
}

async function cleanup() {
  await stopDriver();
  if (dataRoot && process.env.E2E_KEEP !== "1") rmSync(dataRoot, { recursive: true, force: true });
  else if (dataRoot) console.log(`data kept in ${dataRoot}`);
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

// ---------- scenario ----------
async function openApp() {
  const s = await Session.start();
  // The app is ready once the project list has loaded (onboarding, empty state or list).
  await s.waitFor(
    `document.querySelector('.onboarding, .empty, .project-list, .banner-error')`,
    "projects view loaded",
  );
  return s;
}

async function main() {
  if (!existsSync(BIN)) throw new Error(`app binary not found: ${BIN} (build it with npm run tauri build -- --debug --no-bundle)`);
  if (ARTIFACTS) mkdirSync(ARTIFACTS, { recursive: true });
  const before = repoSnapshot();
  await startDriver();
  const dbPath = join(dataRoot, "data", IDENTIFIER, "localis.db");

  // 1. First start: onboarding.
  let s = await openApp();
  await s.screenshot("01-first-start");
  check("first start shows onboarding", (await s.text("#onboarding-title")) === "Benvenuto in Localis");
  check("no load error on first start", !(await s.exec(`return !!document.querySelector('.banner-error');`)));
  check("database created in app data dir", existsSync(dbPath), dbPath);

  await s.click(await s.findByText("button", "Crea il primo progetto"));
  await s.waitFor(`document.activeElement && document.activeElement.id === 'project-name'`, "focus on Nome");
  check("create dialog opens with focus on Nome", true);

  // Empty name -> error next to the field, focus on the field.
  await s.click(await s.findByText("dialog[@open]//button", "Crea progetto"));
  await s.waitFor(`document.querySelector('#project-name-error')`, "name error");
  check("empty name: error message next to field", (await s.text("#project-name-error")) === "Inserisci un nome.");
  check(
    "empty name: field marked invalid and focused",
    await s.exec(`const i = document.getElementById('project-name');
      return i.getAttribute('aria-invalid') === 'true' && document.activeElement === i
        && i.getAttribute('aria-describedby').includes('project-name-error');`),
  );

  // Whitespace-only name goes to the backend validation path too? Client rejects first; check it anyway.
  await s.type(await s.find("#project-name"), "   ");
  await s.click(await s.findByText("dialog[@open]//button", "Crea progetto"));
  await s.waitFor(`document.querySelector('#project-name-error')`, "whitespace name error");
  check("whitespace name: error next to field", (await s.text("#project-name-error")) === "Inserisci un nome.");
  await s.screenshot("02-empty-name-error");

  // Valid project.
  await s.exec(`const i = document.getElementById('project-name');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await s.type(await s.find("#project-name"), PROJECT_NAME);
  await s.type(await s.find("#project-description"), "Creato dal test E2E nativo.");
  await s.click(await s.findByText("dialog[@open]//button", "Crea progetto"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "create dialog closed");
  await s.waitFor(`document.querySelector('.project-option')`, "project listed");
  check("created project appears in list", JSON.stringify(await s.projectNames()) === JSON.stringify([PROJECT_NAME]));
  check(
    "created project is selected and shown in detail",
    await s.exec(`return document.querySelector('.project-option[aria-selected="true"]')?.textContent.trim() === arguments[0]
      && document.getElementById('project-detail-title')?.textContent.trim() === arguments[0];`, [PROJECT_NAME]),
  );
  check(
    "focus returns to the new project's option",
    await s.exec(`return document.activeElement?.classList.contains('project-option');`),
  );

  // Duplicate (backend validation through the real IPC), case-insensitive.
  await s.click(await s.find("#header-new-project"));
  await s.waitFor(`document.activeElement?.id === 'project-name'`, "focus on Nome (2)");
  await s.type(await s.find("#project-name"), PROJECT_NAME.toUpperCase());
  await s.click(await s.findByText("dialog[@open]//button", "Crea progetto"));
  await s.waitFor(`document.querySelector('#project-name-error')`, "duplicate error");
  check(
    "duplicate name (backend): error next to field",
    (await s.text("#project-name-error")) === "Esiste già un progetto con questo nome.",
  );
  await s.screenshot("03-duplicate-error");
  await s.keys(""); // Escape
  await s.waitFor(`!document.querySelector('dialog[open]')`, "dialog closed by Esc");
  check("Esc closes the create dialog", true);

  // Theme: Scuro.
  await s.click(await s.findByText("button", "Impostazioni"));
  await s.waitFor(`document.querySelector('input[name=theme][value=dark]')`, "settings view");
  await s.click(await s.find("input[name=theme][value=dark]"));
  await s.waitFor(`document.documentElement.dataset.theme === 'dark'`, "dark theme applied");
  check("theme Scuro applied immediately", true);
  await s.screenshot("04-dark-theme");

  // CSP: the app works under it (it just did), it is enforced, and the inline
  // pre-paint theme script in index.html is allowed (Tauri adds its hash to the CSP).
  const csp = await wd("POST", s.p("/execute/async"), {
    script: `const done = arguments[arguments.length - 1];
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
      let evalBlocked = false;
      try { new Function('return 1')(); } catch (e) { evalBlocked = true; }
      // Re-run the exact inline theme script: it only runs if its hash is allowed.
      const original = [...document.scripts].find((x) => !x.src);
      document.documentElement.dataset.theme = 'probe';
      const copy = document.createElement('script');
      copy.textContent = original ? original.textContent : '';
      document.head.appendChild(copy);
      const inlineHashAllowed = document.documentElement.dataset.theme === 'dark';
      document.documentElement.dataset.theme = 'dark';
      // A foreign inline script must be blocked.
      window.__probe = 0;
      const foreign = document.createElement('script');
      foreign.textContent = 'window.__probe = 1';
      document.head.appendChild(foreign);
      fetch('https://example.com/').then(() => 'ok', (e) => String(e)).then((fetchResult) =>
        setTimeout(() => done({ evalBlocked, inlineHashAllowed, foreignInlineBlocked: window.__probe === 0,
          hasInline: !!original, fetchResult, violations }), 300));`,
    args: [],
  });
  console.log(`      CSP probe: ${JSON.stringify(csp)}`);
  check("CSP enforced: eval blocked", csp.evalBlocked);
  check("CSP enforced: foreign inline script blocked", csp.foreignInlineBlocked);
  check("CSP enforced: network fetch blocked by connect-src", csp.violations.includes("connect-src"));
  check("CSP allows the inline pre-paint theme script (hash)", csp.hasInline && csp.inlineHashAllowed);
  // Let WebKit flush localStorage before the process is killed.
  await sleep(1500);
  await s.quit();

  // 2. Restart: project and theme persisted, onboarding not shown.
  s = await openApp();
  await s.screenshot("05-restart");
  check("after restart: onboarding not shown", !(await s.exec(`return !!document.querySelector('.onboarding');`)));
  check("after restart: project still listed", JSON.stringify(await s.projectNames()) === JSON.stringify([PROJECT_NAME]));
  check(
    "after restart: data-theme is dark",
    (await s.exec(`return document.documentElement.dataset.theme;`)) === "dark",
  );
  check(
    "after restart: theme preference stored as dark",
    (await s.exec(`try { return localStorage.getItem('localis.theme'); } catch (e) { return String(e); }`)) === "dark",
  );

  // Layout and keyboard in the real webview: no horizontal overflow at the minimum
  // window width and when large; Tab stays inside a modal dialog.
  for (const [width, height] of [[480, 400], [720, 600], [1920, 1080]]) {
    await wd("POST", s.p("/window/rect"), { width, height });
    await sleep(400);
    const o = await s.exec(`const d = document.documentElement, m = document.querySelector('.main');
      return { inner: innerWidth, doc: d.scrollWidth > d.clientWidth, main: m.scrollWidth > m.clientWidth,
        newBtn: (() => { const r = document.getElementById('header-new-project').getBoundingClientRect(); return r.right <= innerWidth; })() };`);
    check(`window ${width}x${height}: no horizontal overflow, «Nuovo progetto» visible`, !o.doc && !o.main && o.newBtn, JSON.stringify(o));
    await s.screenshot(`layout-${width}x${height}`);
  }
  await wd("POST", s.p("/window/rect"), { width: 1200, height: 780 });
  await s.click(await s.find("#header-new-project"));
  await s.waitFor(`document.activeElement?.id === 'project-name'`, "create dialog focus");
  const stops = [];
  for (let i = 0; i < 6; i++) {
    await s.keys("\uE004"); // Tab
    stops.push(await s.exec(`const a = document.activeElement; return (a.closest('dialog[open]') ? 'in:' : 'OUT:') + (a.id || a.textContent.trim() || a.tagName);`));
  }
  console.log(`      Tab stops in create dialog: ${stops.join(" -> ")}`);
  check("native webview: Tab never leaves the open dialog", stops.every((x) => x.startsWith("in:")));
  check(
    "native webview: focus ring visible on dialog buttons",
    await s.exec(`const b = [...document.querySelectorAll('dialog[open] button')].find(x => x.textContent.trim() === 'Annulla'); b.focus();
      const cs = getComputedStyle(b); return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;`),
  );
  await s.keys("\uE00C");
  await s.waitFor(`!document.querySelector('dialog[open]')`, "create dialog closed");
  check("native webview: Esc returns focus to «Nuovo progetto»", (await s.exec(`return document.activeElement?.id;`)) === "header-new-project");

  // 3. Delete -> Annulla.
  await s.click(await s.find("#delete-project-trigger"));
  await s.waitFor(`document.querySelector('dialog[open] #delete-project-title')`, "delete dialog");
  check(
    "delete dialog names the project",
    (await s.text("#delete-project-title")) === `Eliminare «${PROJECT_NAME}»?`,
  );
  check(
    "delete dialog initial focus on Annulla",
    (await s.exec(`return document.activeElement?.textContent.trim();`)) === "Annulla",
  );
  await s.screenshot("06-delete-dialog");
  await s.click(await s.findByText("dialog[@open]//button", "Annulla"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "delete dialog closed");
  check("Annulla: project still listed", JSON.stringify(await s.projectNames()) === JSON.stringify([PROJECT_NAME]));
  check(
    "Annulla: focus returns to Elimina",
    (await s.exec(`return document.activeElement?.id;`)) === "delete-project-trigger",
  );

  // Delete -> Esc.
  await s.click(await s.find("#delete-project-trigger"));
  await s.waitFor(`document.querySelector('dialog[open] #delete-project-title')`, "delete dialog (2)");
  await s.keys("");
  await s.waitFor(`!document.querySelector('dialog[open]')`, "delete dialog closed by Esc");
  check("Esc on delete dialog: project still listed", (await s.projectNames()).length === 1);

  // Delete -> confirm.
  await s.click(await s.find("#delete-project-trigger"));
  await s.waitFor(`document.querySelector('dialog[open] #delete-project-title')`, "delete dialog (3)");
  await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "delete dialog closed after confirm");
  await s.waitFor(`document.querySelector('.empty')`, "empty state");
  check("confirm: project removed, empty state shown", (await s.projectNames()).length === 0);
  check(
    "confirm: focus moves to «Nuovo progetto» in the empty state",
    (await s.exec(`return document.activeElement?.id;`)) === "empty-new-project",
  );
  await s.screenshot("07-after-delete");
  await sleep(500);
  await s.quit();

  // 4. Restart: still gone, empty state (not onboarding).
  s = await openApp();
  check("after restart: deleted project does not come back", (await s.projectNames()).length === 0);
  check(
    "after restart: empty state, not onboarding",
    await s.exec(`return !!document.querySelector('.empty') && !document.querySelector('.onboarding');`),
  );
  await s.quit();

  // 5. Files: DB only in the isolated app data dir, nothing written in the repo.
  check("database file exists in isolated app data dir", existsSync(dbPath), dbPath);
  const after = repoSnapshot();
  const changed = [...after].filter(([f, m]) => before.get(f) !== m).map(([f]) => f);
  check("nothing written to the repository", changed.length === 0, changed.join(", "));
  const strayDb = spawnSync("sh", ["-c", `find ${JSON.stringify(REPO)} -path '*/node_modules' -prune -o -path '*/target' -prune -o \\( -name '*.db' -o -name '*.db-wal' -o -name '*.sqlite' \\) -print`], { encoding: "utf8" }).stdout.trim();
  check("no database files in the repository", strayDb === "", strayDb);
  const dataFiles = spawnSync("find", [dataRoot, "-type", "f", "-path", `*${IDENTIFIER}*`], { encoding: "utf8" }).stdout.trim();
  console.log(`      app files under the temporary dir:\n${dataFiles.split("\n").map((l) => `        ${l.replace(dataRoot, "$TMP")}`).join("\n")}`);
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
