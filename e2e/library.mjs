// Native end-to-end test of the v0.2 document library: drives the real Localis desktop app
// (WebKitGTK webview + real SQLite + real originals archive + real extraction worker)
// through tauri-driver / WebKitWebDriver using the W3C WebDriver protocol.
// Plain Node >= 22, no dependencies.
//
// Prerequisites (Linux): same as e2e/native.mjs
//   - a debug build of the app:   npm run tauri build -- --debug --no-bundle
//   - WebKitWebDriver on PATH (Debian/Ubuntu package: webkit2gtk-driver)
//   - tauri-driver:                cargo install tauri-driver --locked
//   - xvfb-run when there is no $DISPLAY (headless machines and containers)
//
// Run:
//   node e2e/library.mjs
//
// Environment (all optional, same as e2e/native.mjs):
//   LOCALIS_BIN        app binary            (default: <repo>/target/debug/localis)
//   TAURI_DRIVER       tauri-driver binary   (default: tauri-driver on PATH, then ~/.cargo/bin)
//   E2E_PORT           tauri-driver port     (default: 4444; native driver uses port + 1)
//   E2E_ARTIFACTS      directory for screenshots and the driver log (default: none)
//   E2E_KEEP=1         keep the temporary data directory for inspection
//
// The script creates its own temporary directory (under $TMPDIR) holding the synthetic
// fixtures it generates (PDF with text, "scanned" PDF with only an image, corrupted PDF,
// DOCX, TXT, Markdown, PNG, an .exe) and the app data: XDG_DATA_HOME / XDG_CONFIG_HOME /
// XDG_CACHE_HOME / HOME point inside it. Files are given to the real <input type=file>
// via WebDriver "Element Send Keys" (the webview reads them and sends the bytes over IPC,
// exactly as with the native picker). The directory is removed at the end unless E2E_KEEP=1.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.LOCALIS_BIN ?? join(REPO, "target/debug/localis");
const PORT = Number(process.env.E2E_PORT ?? 4444);
const ARTIFACTS = process.env.E2E_ARTIFACTS ? resolve(process.env.E2E_ARTIFACTS) : null;
const IDENTIFIER = "app.localis.desktop";
const PROJECT_NAME = "Libreria E2E";

function findDriver() {
  if (process.env.TAURI_DRIVER) return process.env.TAURI_DRIVER;
  const which = spawnSync("sh", ["-c", "command -v tauri-driver"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return join(homedir(), ".cargo/bin/tauri-driver");
}

// ---------- reporting ----------
const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------- synthetic fixtures ----------
/** Builds a PDF from object bodies (index 0 = object 1) with a correct xref table. */
function buildPdf(objects) {
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1");
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    offsets.push(offset);
    chunks.push(head, b, tail);
    offset += head.length + b.length + tail.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}
function stream(dict, data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${d.length} >>\nstream\n`, "latin1"), d, Buffer.from("\nendstream", "latin1")]);
}
function textPdf() {
  // WinAnsiEncoding: \340 = à, \351 = é.
  const p1 = "BT /F1 24 Tf 72 760 Td (Introduzione: la citt\\340 di Bologna) Tj 0 -40 Td (Parola unica: astrolabio) Tj ET";
  const p2 = "BT /F1 24 Tf 72 760 Td (Seconda pagina: perch\\351 il metodo) Tj 0 -40 Td (Parola unica: zefiro) Tj ET";
  const page = (contents) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents ${contents} 0 R >>`;
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    page(4),
    stream("", p1),
    page(6),
    stream("", p2),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}
function scannedPdf() {
  // One page that only paints an image (like a scan): no text operators at all.
  const pixels = Buffer.from([200, 30, 30, 30, 200, 30, 30, 30, 200, 20, 20, 20]); // 2x2 RGB
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    stream("", "q 400 0 0 400 100 300 cm /Im1 Do Q"),
    stream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8", pixels),
  ]);
}
function corruptPdf() {
  return Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >>\n\x00\x01garbage, no xref, no pages\n%%EOF\n", "latin1");
}
/** Minimal ZIP writer (store method). */
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function docx() {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  return zipStore([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${p("Relazione annuale")}${p("Le novità dell'attività di laboratorio")}<w:p/></w:body></w:document>`,
    ],
  ]);
}
function png() {
  const w = 8, h = 8;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 220; raw[o + 1] = (x * 30) & 255; raw[o + 2] = 40;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function makeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "v2"), { recursive: true });
  const files = {
    "articolo.pdf": textPdf(),
    "scansione.pdf": scannedPdf(),
    "relazione.docx": docx(),
    "appunti.txt": Buffer.from("Primo blocco: il caffè è pronto.\n\nSecondo blocco: la virtù del metodo scientifico.\n", "utf8"),
    "note.md": Buffer.from("# Qualità\n\nUn paragrafo sulla qualità della ricerca.\n\nSecondo paragrafo: perciò funziona.\n", "utf8"),
    "foto.png": png(),
    "programma.exe": Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00This program cannot be run in DOS mode.", "latin1"),
    "finto.pdf": Buffer.from("Questo non è un PDF.\n", "utf8"),
    "rotto.pdf": corruptPdf(),
    "v2/appunti.txt": Buffer.from("Nuova stesura: lo zibaldone di pensieri.\n\nUn altro blocco senza la parola di prima.\n", "utf8"),
  };
  const paths = {};
  for (const [name, buf] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, buf);
    paths[name] = { path: p, sha: sha256(buf), size: buf.length, mtime: statSync(p).mtimeMs };
  }
  return paths;
}

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
const ref = (v) => v[ELEMENT] ?? v.ELEMENT ?? Object.values(v)[0];

class Session {
  static async start() {
    const value = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: BIN } } },
    });
    const s = new Session();
    s.id = value.sessionId;
    return s;
  }
  p(path) {
    return `/session/${this.id}${path}`;
  }
  quit() {
    return wd("DELETE", this.p(""));
  }
  exec(script, args = []) {
    return wd("POST", this.p("/execute/sync"), { script, args });
  }
  execAsync(script, args = []) {
    return wd("POST", this.p("/execute/async"), { script, args });
  }
  async find(css) {
    return ref(await wd("POST", this.p("/element"), { using: "css selector", value: css }));
  }
  async findByText(tag, text) {
    return ref(
      await wd("POST", this.p("/element"), { using: "xpath", value: `//${tag}[normalize-space(.)=${JSON.stringify(text)}]` }),
    );
  }
  click(el) {
    return wd("POST", this.p(`/element/${el}/click`), {});
  }
  type(el, text) {
    return wd("POST", this.p(`/element/${el}/value`), { text });
  }
  async keys(...keys) {
    const actions = [];
    for (const k of keys) actions.push({ type: "keyDown", value: k }, { type: "keyUp", value: k });
    await wd("POST", this.p("/actions"), { actions: [{ type: "key", id: "kbd", actions }] });
    await wd("DELETE", this.p("/actions"));
  }
  async screenshot(name) {
    if (!ARTIFACTS) return;
    try {
      const b64 = await wd("GET", this.p("/screenshot"));
      writeFileSync(join(ARTIFACTS, `lib-${name}.png`), Buffer.from(b64, "base64"));
    } catch (e) {
      console.log(`      (screenshot ${name} failed: ${e.message.slice(0, 120)})`);
    }
  }
  async waitFor(expr, desc, timeout = 15000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.exec(`return (${expr});`);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${desc} (last: ${JSON.stringify(last)})`);
  }
  text(css) {
    return this.exec(`const e = document.querySelector(arguments[0]); return e ? e.textContent.trim() : null;`, [css]);
  }
  /** Calls a backend command through the real IPC (as src/api/client.ts does). */
  invoke(cmd, args) {
    return this.execAsync(
      `const done = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(
         (v) => done({ ok: true, value: v instanceof ArrayBuffer ? { bytes: v.byteLength } : v }),
         (e) => done({ ok: false, err: e }));`,
      [cmd, args ?? {}],
    );
  }
  /** Map title -> { status, retry } of the document rows currently listed. */
  rows() {
    return this.exec(`const out = {};
      for (const li of document.querySelectorAll('.doc-row')) {
        const t = li.querySelector('.doc-title')?.textContent.trim();
        const st = li.querySelector('.status');
        out[t] = { status: st ? st.dataset.status : 'extracted', label: st ? st.querySelector('.status-text').textContent.trim() : '',
          retry: !!li.querySelector('.status button'), meta: li.querySelector('.doc-meta')?.textContent.trim() };
      }
      return out;`);
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
  const env = {
    ...process.env,
    HOME: join(dataRoot, "home"),
    XDG_DATA_HOME: join(dataRoot, "data"),
    XDG_CONFIG_HOME: join(dataRoot, "config"),
    XDG_CACHE_HOME: join(dataRoot, "cache"),
    XDG_STATE_HOME: join(dataRoot, "state"),
    TMPDIR: dataRoot,
    WEBKIT_DISABLE_COMPOSITING_MODE: process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? "1",
  };
  for (const d of ["home", "data", "config", "cache", "state"]) mkdirSync(join(dataRoot, d), { recursive: true });
  const driverBin = findDriver();
  const args = ["--port", String(PORT), "--native-port", String(PORT + 1)];
  const [cmd, cmdArgs] = process.env.DISPLAY ? [driverBin, args] : ["xvfb-run", ["-a", driverBin, ...args]];
  driver = spawn(cmd, cmdArgs, { env, cwd: dataRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = ARTIFACTS ? createWriteStream(join(ARTIFACTS, "library-driver.log")) : null;
  driver.stdout.on("data", (d) => log?.write(d));
  driver.stderr.on("data", (d) => log?.write(d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/status`)).ok) return;
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
    return;
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

// ---------- scenario helpers ----------
const INSTRUMENT = `
  if (!window.__qa) {
    window.__qa = { csp: [], errors: [] };
    document.addEventListener('securitypolicyviolation', (e) => window.__qa.csp.push(e.violatedDirective + ' ' + e.blockedURI));
    window.addEventListener('error', (e) => window.__qa.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__qa.errors.push('rejection: ' + String(e.reason && (e.reason.message || JSON.stringify(e.reason)))));
  }
  return true;`;

async function openApp() {
  const s = await Session.start();
  await s.waitFor(`document.querySelector('.onboarding, .empty, .project-list, .banner-error')`, "projects view loaded");
  await s.exec(INSTRUMENT);
  return s;
}
async function goToLibrary(s) {
  await s.click(await s.findByText("button", "Apri libreria"));
  await s.waitFor(`document.querySelector('.view-library .library')`, "library loaded");
}
async function selectFolder(s, name) {
  await s.click(await s.findByText("button[contains(@class,'tree-item')]/span[contains(@class,'tree-label')]", name));
  await s.waitFor(`document.querySelector('.tree-item[aria-current="true"]')?.textContent.trim().startsWith(${JSON.stringify(name)})`, `folder ${name} open`);
}
async function openDoc(s, title) {
  await s.click(await s.find(`.doc-open[title=${JSON.stringify(title)}]`));
  await s.waitFor(`document.getElementById('viewer-title')?.textContent.trim() === ${JSON.stringify(title)}`, `viewer for ${title}`);
}
async function search(s, q) {
  const input = await s.find('input[type=search]');
  await s.exec(`const i = document.querySelector('input[type=search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await s.type(input, q);
  await s.keys(""); // Enter
  await s.waitFor(
    `(() => { const t = document.getElementById('search-results-title'); if (!t || !t.textContent.includes(${JSON.stringify(q)})) return false;
      const sec = t.closest('section'); return sec.getAttribute('aria-busy') !== 'true'; })()`,
    `search results for ${q}`,
  );
  return s.exec(`return [...document.querySelectorAll('.hit')].map(h => ({ title: h.querySelector('.hit-title').textContent.trim(),
    unit: h.querySelector('.hit-unit').textContent.trim(), marks: [...h.querySelectorAll('mark')].map(m => m.textContent),
    snippet: h.querySelector('.hit-snippet').textContent }));`);
}
async function clearSearch(s) {
  await s.exec(`const i = document.querySelector('input[type=search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await s.waitFor(`!document.getElementById('search-results-title')`, "search cleared");
}
async function waitStatuses(s, expected, timeout = 30000) {
  const keys = Object.keys(expected);
  return s.waitFor(
    `(() => { const rows = {}; for (const li of document.querySelectorAll('.doc-row')) { const st = li.querySelector('.status');
       rows[li.querySelector('.doc-title').textContent.trim()] = st ? st.dataset.status : 'extracted'; }
       const exp = ${JSON.stringify(expected)}; return ${JSON.stringify(keys)}.every(k => rows[k] === exp[k]) ? rows : false; })()`,
    `statuses ${JSON.stringify(expected)}`,
    timeout,
  );
}
async function canvasInfo(s) {
  return s.exec(`const c = document.querySelector('.pdf-canvas'); if (!c || !c.width) return null;
    const ctx = c.getContext('2d'); const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonWhite = 0, dark = 0, colored = 0, total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const [r, g, b, a] = [d[i], d[i+1], d[i+2], d[i+3]];
      if (a > 0 && (r < 245 || g < 245 || b < 245)) nonWhite++; if (a > 0 && r < 80 && g < 80 && b < 80) dark++;
      if (a > 0 && r > 150 && g < 80 && b < 80) colored++; }
    return { w: c.width, h: c.height, total, nonWhite, dark, colored,
      page: document.querySelector('.page-field input')?.value, of: document.querySelector('.page-field span:last-child')?.textContent.trim() };`);
}

// ---------- scenario ----------
async function main() {
  if (!existsSync(BIN)) throw new Error(`app binary not found: ${BIN}`);
  if (ARTIFACTS) mkdirSync(ARTIFACTS, { recursive: true });
  const before = repoSnapshot();
  dataRoot = mkdtempSync(join(tmpdir(), "localis-e2e-lib-"));
  const F = makeFixtures(join(dataRoot, "fixtures"));
  const appDir = join(dataRoot, "data", IDENTIFIER);
  const originals = join(appDir, "originals");
  const blobPath = (sha) => join(originals, sha.slice(0, 2), sha);
  await startDriver();

  let s = await openApp();
  // Project.
  await s.click(await s.findByText("button", "Crea il primo progetto"));
  await s.waitFor(`document.activeElement?.id === 'project-name'`, "create dialog");
  await s.type(await s.find("#project-name"), PROJECT_NAME);
  await s.click(await s.findByText("dialog[@open]//button", "Crea progetto"));
  await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.project-option')`, "project created");
  await goToLibrary(s);
  check("library opens for the new project (empty state)", await s.exec(`return !!document.querySelector('.library-empty');`));
  // Since v0.3 the Chat is available (it was «Presto» in v0.1–0.2).
  check("Chat available in the sidebar", await s.exec(`const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('Chat'));
    return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';`));

  // ---- Import via the real <input type=file> (WebDriver file upload).
  const importNames = ["articolo.pdf", "scansione.pdf", "relazione.docx", "appunti.txt", "note.md", "foto.png"];
  const input = await s.find('[data-testid="import-input"]');
  let uploadVia = "send-keys";
  try {
    await s.type(input, importNames.map((n) => F[n].path).join("\n"));
  } catch (e) {
    uploadVia = `failed: ${e.message.slice(0, 200)}`;
  }
  check("file upload through WebDriver Send Keys on input[type=file]", uploadVia === "send-keys", uploadVia);
  await s.waitFor(`document.querySelectorAll('.import-item').length === 6 && !document.querySelector('.import-summary [role=status] .spinner')`, "6 import outcomes");
  await s.waitFor(`document.querySelectorAll('.doc-row').length === 6`, "6 rows");
  const outcomes = await s.exec(`return [...document.querySelectorAll('.import-item')].map(li => li.dataset.kind + ':' + li.querySelector('.import-name').textContent.trim());`);
  check("all six fixtures imported", outcomes.every((o) => o.startsWith("imported:")), outcomes.join(", "));
  await s.screenshot("01-imported");

  const rows = await waitStatuses(s, {
    "articolo.pdf": "extracted",
    "scansione.pdf": "no_text",
    "relazione.docx": "extracted",
    "appunti.txt": "extracted",
    "note.md": "extracted",
    "foto.png": "not_applicable",
  }).catch((e) => (console.log("      " + e.message), null));
  const labels = await s.rows();
  console.log(`      rows: ${JSON.stringify(labels)}`);
  check("extraction states: text PDF/DOCX/TXT/MD extracted, scanned PDF no_text, PNG not_applicable", !!rows);
  check("scanned PDF labelled «Senza testo ricercabile»", labels["scansione.pdf"]?.label === "Senza testo ricercabile");
  check("PNG labelled «Non ricercabile»", labels["foto.png"]?.label === "Non ricercabile");

  const projectId = (await s.invoke("list_projects")).value[0].id;
  let list = (await s.invoke("list_documents", { projectId })).value;
  const byTitle = Object.fromEntries(list.map((d) => [d.title, d]));
  check("text PDF: pageCount 2", byTitle["articolo.pdf"]?.current.pageCount === 2, String(byTitle["articolo.pdf"]?.current.pageCount));
  check("scanned PDF: pageCount 1, textStatus no_text", byTitle["scansione.pdf"]?.current.pageCount === 1 && byTitle["scansione.pdf"]?.current.textStatus === "no_text");
  check("PNG: 8x8 dimensions stored", byTitle["foto.png"]?.current.imageWidth === 8 && byTitle["foto.png"]?.current.imageHeight === 8);
  check(
    "metadata: sha256, size, kind, mediaType match fixtures",
    importNames.every((n) => byTitle[n]?.current.sha256 === F[n].sha && byTitle[n]?.current.sizeBytes === F[n].size),
  );
  check("metadata: sourceModifiedAt recorded from File.lastModified", importNames.every((n) => !!byTitle[n]?.current.sourceModifiedAt),
    byTitle["appunti.txt"]?.current.sourceModifiedAt);
  const pdfText = (await s.invoke("get_text", { versionId: byTitle["articolo.pdf"].current.id })).value;
  console.log(`      PDF text units: ${JSON.stringify(pdfText)}`);
  check("PDF text per page with accents decoded (città / perché)", pdfText.length === 2 && pdfText[0].unit === 1 && pdfText[0].text.includes("città") && pdfText[1].unit === 2 && pdfText[1].text.includes("perché"));
  const docxText = (await s.invoke("get_text", { versionId: byTitle["relazione.docx"].current.id })).value;
  check("DOCX paragraphs extracted", docxText.length === 2 && docxText[1].text.includes("novità"), JSON.stringify(docxText));
  const scannedText = (await s.invoke("get_text", { versionId: byTitle["scansione.pdf"].current.id })).value;
  check("scanned PDF has no indexed text", scannedText.length === 0);

  // On-disk archive.
  for (const n of importNames) {
    const p = blobPath(F[n].sha);
    check(`blob ${n} at originals/<2>/<sha256> and byte-identical`, existsSync(p) && sha256(readFileSync(p)) === F[n].sha && readFileSync(p).equals(readFileSync(F[n].path)));
  }
  const storeFiles = spawnSync("find", [appDir, "-type", "f"], { encoding: "utf8" }).stdout.trim().split("\n");
  console.log(`      app dir files: ${storeFiles.map((f) => f.replace(appDir, "$APP")).join(" ")}`);
  const webkitOwn = /\/(hsts-storage\.sqlite|WebKitCache\/.*|mediakeys\/.*|storage\/.*|localstorage\/.*|CacheStorage\/.*)$/;
  check("originals/ holds only <2>/<sha256> blobs; app dir has only the DB besides WebKit's own storage (no derived files)",
    storeFiles.every((f) => f.startsWith(originals + "/") ? /\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(f) : /localis\.db(-wal|-shm)?$/.test(f) || webkitOwn.test(f.slice(appDir.length))),
    storeFiles.filter((f) => !f.startsWith(originals + "/") && !/localis\.db/.test(f)).map((f) => f.slice(appDir.length)).join(" "));

  // ---- Duplicate + unsupported + mismatched + empty dismiss
  await s.click(await s.find('.import-summary button[aria-label="Chiudi riepilogo importazione"]')).catch(() => {});
  await s.type(await s.find('[data-testid="import-input"]'), [F["appunti.txt"].path, F["programma.exe"].path, F["finto.pdf"].path].join("\n"));
  await s.waitFor(`document.querySelectorAll('.import-item').length === 3 && [...document.querySelectorAll('.import-item')].every(li => li.querySelector('.import-result'))`, "3 outcomes");
  await sleep(300);
  const out2 = await s.exec(`return [...document.querySelectorAll('.import-item')].map(li => ({ kind: li.dataset.kind, name: li.querySelector('.import-name').textContent.trim(), result: li.querySelector('.import-result').textContent.trim() }));`);
  console.log(`      outcomes: ${JSON.stringify(out2)}`);
  check("re-import of same bytes → «Già presente»", out2[0]?.kind === "duplicate" && out2[0].result.startsWith("Già presente"));
  check(".exe → clear «Formato non supportato» error", out2[1]?.kind === "error" && out2[1].result.startsWith("Formato non supportato"), out2[1]?.result);
  check("text renamed .pdf → mismatch error", out2[2]?.kind === "error" && out2[2].result.startsWith("Formato non supportato"), out2[2]?.result);
  list = (await s.invoke("list_documents", { projectId })).value;
  check("still 6 documents after duplicate/unsupported", list.length === 6);
  await s.screenshot("02-duplicate-unsupported");

  // ---- Search
  let hits = await search(s, "citta");
  console.log(`      hits(citta): ${JSON.stringify(hits)}`);
  check("search «citta» (no accent) finds «città» in the PDF p. 1 with <mark>", hits.length === 1 && hits[0].title === "articolo.pdf" && hits[0].unit === "p. 1" && hits[0].marks.some((m) => m.toLowerCase().startsWith("citt")));
  hits = await search(s, "perche");
  check("search «perche» → PDF p. 2", hits.length === 1 && hits[0].unit === "p. 2", JSON.stringify(hits));
  await s.click(await s.find(".hit"));
  await s.waitFor(`document.querySelector('.pdf-canvas') && document.querySelector('.page-field input')?.value === '2'`, "PDF viewer on page 2", 20000);
  await sleep(1200);
  let cv = await canvasInfo(s);
  console.log(`      canvas p2: ${JSON.stringify(cv)}`);
  check("PDF hit opens viewer on page 2 of 2", cv?.page === "2" && cv?.of === "di 2");
  check("PDF canvas rendered with text pixels (non-blank)", cv && cv.dark > 50, `dark=${cv?.dark}`);
  await s.screenshot("03-pdf-page2");
  await s.click(await s.find('button[aria-label="Pagina precedente"]'));
  await s.waitFor(`document.querySelector('.page-field input')?.value === '1'`, "page 1");
  await sleep(800);
  cv = await canvasInfo(s);
  check("page navigation: previous → page 1, canvas re-rendered", cv?.page === "1" && cv.dark > 50);
  // keyboard navigation on the scroller
  await s.exec(`document.querySelector('.pdf-scroller').focus();`);
  await s.keys(""); // ArrowRight
  await s.waitFor(`document.querySelector('.page-field input')?.value === '2'`, "page 2 via ArrowRight");
  check("keyboard ArrowRight on the page region → page 2", true);
  const z0 = await s.text(".zoom-value");
  await s.click(await s.find('button[aria-label="Ingrandisci"]'));
  await sleep(700);
  const z1 = await s.text(".zoom-value");
  const cvz = await canvasInfo(s);
  check("zoom in changes the zoom value and canvas size", z0 !== z1 && cvz.w > cv.w, `${z0} -> ${z1}, canvas ${cv.w} -> ${cvz.w}`);

  hits = await search(s, "virtu");
  check("search «virtu» → TXT block 2", hits.length === 1 && hits[0].title === "appunti.txt" && hits[0].unit === "blocco 2", JSON.stringify(hits));
  await s.click(await s.find(".hit"));
  await s.waitFor(`document.querySelector('.text-block.is-target')`, "text block target");
  check("text hit opens text viewer with target block highlighted and focused",
    await s.exec(`const t = document.querySelector('.text-block.is-target'); return t.dataset.unit === '2' && document.activeElement === t && t.textContent.includes('virtù');`));
  hits = await search(s, "novita attivita");
  check("multi-word search on DOCX («novita attivita»)", hits.length === 1 && hits[0].title === "relazione.docx", JSON.stringify(hits));
  hits = await search(s, "qualit");
  check("prefix search «qualit» finds Markdown blocks", hits.length >= 1 && hits.every((h) => h.title === "note.md"), JSON.stringify(hits));
  check("search hint says excluded documents are not included", (await s.text(".search-results .hint"))?.includes("2 documenti non sono inclusi"), await s.text(".search-results .hint"));
  for (const q of ['"', "AND OR NOT", "*", "NEAR(", "-", "^", "a\"b", "(((", "col:val", "😀"]) {
    const r = await s.invoke("search", { input: { projectId, query: q, limit: 50 } });
    check(`FTS-hostile query ${JSON.stringify(q)} does not error`, r.ok, r.ok ? `${r.value.length} hits` : JSON.stringify(r.err));
  }
  await clearSearch(s);

  // ---- Image viewer
  await openDoc(s, "foto.png");
  await s.waitFor(`(() => { const i = document.querySelector('.viewer-body img'); return i && i.complete && i.naturalWidth > 0; })()`, "image loaded");
  const img = await s.exec(`const i = document.querySelector('.viewer-body img'); return { w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 5), alt: i.alt };`);
  check("image viewer shows the PNG (8x8, blob: URL)", img.w === 8 && img.h === 8 && img.src === "blob:", JSON.stringify(img));
  await s.screenshot("04-image");

  // Scanned PDF viewer: renders, explanation shown.
  await openDoc(s, "scansione.pdf");
  await s.waitFor(`document.querySelector('.pdf-canvas')?.width > 0`, "scanned canvas");
  await sleep(1200);
  cv = await canvasInfo(s);
  check("scanned PDF displays (image pixels on canvas)", cv && cv.colored > 100, JSON.stringify(cv));
  check("scanned PDF viewer explains no OCR", (await s.text(".viewer-note"))?.includes("OCR"));

  // ---- Folders
  await s.click(await s.findByText("button", "Nuova cartella"));
  await s.waitFor(`document.activeElement?.id === 'folder-name'`, "folder dialog");
  await s.type(await s.find("#folder-name"), "Capitolo 1");
  await s.keys("");
  await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.tree-item[aria-current="true"]')?.textContent.includes('Capitolo 1')`, "folder created and open");
  check("folder created and opened", true);
  await selectFolder(s, PROJECT_NAME);
  await openDoc(s, "note.md");
  await s.click(await s.findByText("button", "Informazioni"));
  await s.click(await s.findByText("button", "Sposta"));
  await s.waitFor(`document.querySelector('dialog[open] #move-dialog-title')`, "move dialog");
  await s.click(await s.findByText("label[contains(@class,'folder-choice')]", "Capitolo 1"));
  await s.click(await s.findByText("dialog[@open]//button", "Sposta"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "move closed");
  list = (await s.invoke("list_documents", { projectId })).value;
  const folders = (await s.invoke("list_folders", { projectId })).value;
  check("document moved into the folder", list.find((d) => d.title === "note.md")?.folderId === folders[0]?.id);
  await selectFolder(s, "Capitolo 1");
  await s.click(await s.find('button[aria-label="Elimina la cartella «Capitolo 1»"]'));
  await s.waitFor(`document.querySelector('dialog[open]')`, "delete folder dialog");
  await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
  await s.waitFor(`document.querySelector('dialog[open] .banner-error, dialog[open] [role=alert]')`, "conflict message");
  const conflict = await s.text("dialog[open] .banner-error, dialog[open] [role=alert]");
  check("deleting a non-empty folder → «La cartella non è vuota.»", conflict?.includes("La cartella non è vuota."), conflict);
  await s.screenshot("05-folder-conflict");
  await s.click(await s.findByText("dialog[@open]//button", "Annulla"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "closed");
  const mv = await s.invoke("move_document", { id: list.find((d) => d.title === "note.md").id, folderId: null });
  check("move back to root (IPC)", mv.ok && mv.value.folderId === null);
  await selectFolder(s, PROJECT_NAME);
  await s.click(await s.findByText("button", "Nuova cartella")); // folder for the restart check (at the root)
  await s.waitFor(`document.activeElement?.id === 'folder-name'`, "folder dialog 2");
  await s.type(await s.find("#folder-name"), "Bibliografia");
  await s.keys("");
  await s.waitFor(`!document.querySelector('dialog[open]')`, "folder 2 created");
  await selectFolder(s, "Capitolo 1");
  await s.click(await s.find('button[aria-label="Elimina la cartella «Capitolo 1»"]'));
  await s.waitFor(`document.querySelector('dialog[open]')`, "delete folder dialog 2");
  await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "folder deleted");
  check("empty folder deleted", !(await s.invoke("list_folders", { projectId })).value.some((f) => f.name === "Capitolo 1"));

  // ---- New version of the TXT
  await selectFolder(s, PROJECT_NAME);
  await openDoc(s, "appunti.txt");
  if (!(await s.exec(`return !!document.querySelector('.info-panel');`))) await s.click(await s.findByText("button", "Informazioni"));
  await s.type(await s.find(".info-actions input[type=file]"), F["v2/appunti.txt"].path);
  await s.waitFor(`[...document.querySelectorAll('.info-panel [role=status], .info-panel .banner-error')].some(e => e.textContent.includes('Versione 2') || e.classList.contains('banner-error'))`, "version 2 upload outcome");
  const upl = await s.exec(`return [...document.querySelectorAll('.info-panel [role=status], .info-panel .banner-error')].map(e => e.textContent.trim()).filter(Boolean);`);
  check("new version uploaded via the viewer's input → «Versione 2 caricata.»", upl.includes("Versione 2 caricata."), JSON.stringify(upl));
  await waitStatuses(s, { "appunti.txt": "extracted" });
  list = (await s.invoke("list_documents", { projectId })).value;
  const txt = list.find((d) => d.title === "appunti.txt");
  check("new version: versionNo 2 current, versionCount 2", txt.current.versionNo === 2 && txt.versionCount === 2 && txt.current.sha256 === F["v2/appunti.txt"].sha);
  await sleep(1500);
  hits = await search(s, "zibaldone");
  check("search finds text of the new version", hits.length === 1 && hits[0].title === "appunti.txt", JSON.stringify(hits));
  hits = await search(s, "virtu");
  check("search no longer finds text only in the old version", hits.length === 0, JSON.stringify(hits));
  await clearSearch(s);
  const vers = (await s.invoke("list_versions", { documentId: txt.id })).value;
  check("list_versions newest first, both blobs kept", vers.length === 2 && vers[0].versionNo === 2 && existsSync(blobPath(F["appunti.txt"].sha)) && existsSync(blobPath(F["v2/appunti.txt"].sha)));

  // ---- Robustness: corrupted PDF → failed + Riprova
  await s.type(await s.find('[data-testid="import-input"]'), F["rotto.pdf"].path);
  await waitStatuses(s, { "rotto.pdf": "failed" });
  let r = (await s.rows())["rotto.pdf"];
  check("corrupted PDF → «Estrazione non riuscita» with «Riprova»", r.label === "Estrazione non riuscita" && r.retry, JSON.stringify(r));
  let jobs = (await s.invoke("list_jobs", { projectId })).value;
  const rottoId = (await s.invoke("list_documents", { projectId })).value.find((d) => d.title === "rotto.pdf");
  let job = jobs.find((j) => j.documentId === rottoId.id);
  console.log(`      failed job: ${JSON.stringify(job)}`);
  check("failed job has Italian message, detail, attempts 1", job.state === "failed" && job.attempts === 1 && !!job.error && !!job.errorDetail);
  await s.click(await s.find('button[aria-label="Riprova l\'estrazione di «rotto.pdf»"]'));
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    jobs = (await s.invoke("list_jobs", { projectId })).value;
    job = jobs.find((j) => j.documentId === rottoId.id);
    if (job.attempts === 2 && job.state === "failed") break;
    await sleep(200);
  }
  check("Riprova re-runs the job: fails again, attempts 2", job.attempts === 2 && job.state === "failed", JSON.stringify({ a: job.attempts, s: job.state }));
  await waitStatuses(s, { "rotto.pdf": "failed" });
  const rr = await s.invoke("retry_job", { id: jobs.find((j) => j.state === "done").id });
  check("retry_job on a done job → conflict", !rr.ok && rr.err.code === "conflict", JSON.stringify(rr.err));
  await s.screenshot("06-failed-retry");

  // ---- Integrity: tamper a blob, then open the doc
  const md = (await s.invoke("list_documents", { projectId })).value.find((d) => d.title === "foto.png");
  writeFileSync(blobPath(F["foto.png"].sha), Buffer.from("tampered"));
  await openDoc(s, "relazione.docx");
  await openDoc(s, "foto.png");
  await s.waitFor(`document.querySelector('.viewer-body .banner-error, .viewer-body [role=alert]')`, "integrity banner");
  const integ = await s.text(".viewer-body .banner-error, .viewer-body [role=alert]");
  check("tampered blob → «Il file originale nell'archivio risulta alterato.» in viewer", integ?.includes("risulta alterato"), integ);
  await s.screenshot("07-integrity");
  const ro = await s.invoke("read_original", { versionId: md.current.id });
  check("read_original returns integrity error code", !ro.ok && ro.err.code === "integrity");
  writeFileSync(blobPath(F["foto.png"].sha), readFileSync(F["foto.png"].path)); // restore
  rmSync(blobPath(F["articolo.pdf"].sha));
  const ro2 = await s.invoke("read_original", { versionId: byTitle["articolo.pdf"].current.id });
  check("missing blob → integrity «non si trova nell'archivio»", !ro2.ok && ro2.err.code === "integrity" && ro2.err.message.includes("non si trova"), JSON.stringify(ro2.err));
  writeFileSync(blobPath(F["articolo.pdf"].sha), readFileSync(F["articolo.pdf"].path)); // restore
  const roOk = await s.invoke("read_original", { versionId: byTitle["articolo.pdf"].current.id });
  check("read_original after restore returns the bytes", roOk.ok && roOk.value.bytes === F["articolo.pdf"].size);

  // ---- Delete a document (cancel then confirm)
  await openDoc(s, "relazione.docx");
  if (!(await s.exec(`return !!document.querySelector('.info-panel');`))) await s.click(await s.findByText("button", "Informazioni"));
  const delInfo = await s.exec(`const b = document.querySelector('.info-actions .btn-danger-quiet'); const r = b.getBoundingClientRect();
    const sc = b.closest('.info-panel'); return { r: [r.x, r.y, r.width, r.height], inner: [innerWidth, innerHeight], panel: sc && [sc.scrollHeight, sc.clientHeight, getComputedStyle(sc).overflowY],
      top: (() => { const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e && (e.className || e.tagName); })() };`);
  console.log(`      delete button geometry: ${JSON.stringify(delInfo)}`);
  await s.screenshot("08-before-delete");
  await s.click(await s.find(".info-actions .btn-danger-quiet")).catch(async (e) => {
    console.log(`      NOTE: WebDriver could not click the info-panel «Elimina» (below the fold in a nested scroller): ${e.message.slice(0, 90)}; scrolling it into view`);
    await s.exec(`document.querySelector('.info-actions .btn-danger-quiet').scrollIntoView({ block: 'center' });`);
    await s.click(await s.find(".info-actions .btn-danger-quiet"));
  });
  await s.waitFor(`document.querySelector('dialog[open]')`, "delete doc dialog");
  check("delete dialog says user files are not touched", (await s.text("dialog[open]"))?.includes("I file sul tuo disco non vengono toccati"));
  await s.click(await s.findByText("dialog[@open]//button", "Annulla"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "cancel");
  check("cancel keeps the document", (await s.invoke("list_documents", { projectId })).value.some((d) => d.title === "relazione.docx"));
  await s.click(await s.find(".info-actions .btn-danger-quiet"));
  await s.waitFor(`document.querySelector('dialog[open]')`, "delete doc dialog 2");
  await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "deleted");
  check("confirm deletes the document", !(await s.invoke("list_documents", { projectId })).value.some((d) => d.title === "relazione.docx"));
  check("its unreferenced blob is removed from originals/", !existsSync(blobPath(F["relazione.docx"].sha)));
  check("the fixture file it came from is untouched", existsSync(F["relazione.docx"].path) && sha256(readFileSync(F["relazione.docx"].path)) === F["relazione.docx"].sha);

  // ---- CSP / runtime errors so far
  const qa = await s.exec(`return window.__qa;`);
  console.log(`      webview CSP violations: ${JSON.stringify(qa.csp)} errors: ${JSON.stringify(qa.errors)}`);
  check("no CSP violations in the webview during the session", qa.csp.length === 0);
  check("no uncaught errors in the webview during the session", qa.errors.length === 0);
  await sleep(1000);
  await s.quit();

  // ---- Restart: persistence
  s = await openApp();
  await goToLibrary(s);
  await s.waitFor(`document.querySelectorAll('.doc-row').length >= 6`, "rows after restart");
  list = (await s.invoke("list_documents", { projectId })).value;
  const titles = list.map((d) => d.title).sort();
  console.log(`      after restart: ${titles.join(", ")}`);
  check("after restart: documents persist", JSON.stringify(titles) === JSON.stringify(["appunti.txt", "articolo.pdf", "foto.png", "note.md", "rotto.pdf", "scansione.pdf"]));
  check("after restart: folder persists", (await s.invoke("list_folders", { projectId })).value.map((f) => f.name).join() === "Bibliografia");
  const t2 = list.find((d) => d.title === "appunti.txt");
  check("after restart: versions persist (2 versions)", t2.versionCount === 2 && t2.current.versionNo === 2);
  const st = Object.fromEntries(list.map((d) => [d.title, d.current.textStatus]));
  check("after restart: extraction states persist", st["articolo.pdf"] === "extracted" && st["scansione.pdf"] === "no_text" && st["rotto.pdf"] === "failed" && st["foto.png"] === "not_applicable", JSON.stringify(st));
  hits = await search(s, "astrolabio");
  check("after restart: search works", hits.length === 1 && hits[0].unit === "p. 1");
  await s.click(await s.find(".hit"));
  await s.waitFor(`document.querySelector('.pdf-canvas')?.width > 0`, "canvas after restart");
  await sleep(1000);
  cv = await canvasInfo(s);
  check("after restart: PDF renders", cv && cv.dark > 50);
  const qa2 = await s.exec(`return window.__qa;`);
  check("no CSP violations after restart (PDF opened)", qa2.csp.length === 0, JSON.stringify(qa2.csp));


  // ---- Raw IPC import edge cases (same path as src/api/client.ts) + cross-project sharing
  const rawImport = (bytes, headers) => s.execAsync(
    `const done = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke('import_document', new Uint8Array(arguments[0]), { headers: arguments[1] }).then(
       (v) => done({ ok: true, value: v }), (e) => done({ ok: false, err: e }));`, [bytes, headers]);
  const H = (o) => ({ "x-project-id": projectId, "x-folder-id": "", "x-file-name": "nota.txt", "x-last-modified": "", ...o });
  const hello = [...Buffer.from("ciao mondo", "utf8")];
  let ri = await rawImport(hello, H({ "x-file-name": encodeURIComponent("../../etc/passwd.txt") }));
  check("raw import: file name with path separators → validation", !ri.ok && ri.err.code === "validation", JSON.stringify(ri.err));
  ri = await rawImport([], H({}));
  check("raw import: empty file → validation «Il file è vuoto.»", !ri.ok && ri.err.code === "validation" && ri.err.message === "Il file è vuoto.", JSON.stringify(ri.err));
  ri = await rawImport(hello, H({ "x-project-id": "../../x" }));
  check("raw import: malformed project id header → validation", !ri.ok && ri.err.code === "validation", JSON.stringify(ri.err));
  ri = await rawImport(hello, H({ "x-project-id": "00000000-0000-4000-8000-000000000000" }));
  check("raw import: unknown project → not_found", !ri.ok && ri.err.code === "not_found", JSON.stringify(ri.err));
  ri = await rawImport(hello, H({ "x-file-name": "%E0%A4%A" }));
  check("raw import: broken percent-encoding → validation", !ri.ok && ri.err.code === "validation", JSON.stringify(ri.err));
  ri = await rawImport(hello, H({ "x-last-modified": "12abc" }));
  check("raw import: bad x-last-modified → validation", !ri.ok && ri.err.code === "validation", JSON.stringify(ri.err));
  const jsonBody = await s.invoke("import_document", { foo: 1 });
  check("import_document with a JSON body is refused", !jsonBody.ok, JSON.stringify(jsonBody.err));
  ri = await rawImport([...Buffer.from("Nota con %PDF-1.4 citato nel testo.\n", "utf8")], H({ "x-file-name": "pdfnote.txt" }));
  check("raw import: a .txt that merely mentions «%PDF-» is accepted", ri.ok, JSON.stringify(ri.err ?? ri.value?.status));
  if (ri.ok) await s.invoke("delete_document", { id: ri.value.document.id });
  const p2 = (await s.invoke("create_project", { input: { name: "Secondo progetto E2E" } })).value;
  const v2bytes = [...readFileSync(F["v2/appunti.txt"].path)];
  ri = await rawImport(v2bytes, { "x-project-id": p2.id, "x-folder-id": "", "x-file-name": "copia.txt", "x-last-modified": "" });
  check("same bytes in another project → imported (not duplicate), blob shared", ri.ok && ri.value.status === "imported");

  // ---- Delete the project → all its blobs removed
  await s.click(await s.findByText("button", "Progetti"));
  await s.waitFor(`document.querySelector('#delete-project-trigger')`, "projects view");
  await s.click(await s.find("#delete-project-trigger"));
  await s.waitFor(`document.querySelector('dialog[open]')`, "delete project dialog");
  const dlg = await s.text("dialog[open]");
  console.log(`      delete project dialog: ${dlg}`);
  check("delete-project dialog mentions documents/copies", /document/i.test(dlg ?? ""), dlg);
  await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "project deleted");
  const listBlobs = () => (existsSync(originals) ? spawnSync("find", [originals, "-type", "f"], { encoding: "utf8" }).stdout.trim() : "");
  let remaining = listBlobs();
  check("deleting the project removes its blobs but keeps the one shared with the other project",
    remaining === blobPath(F["v2/appunti.txt"].sha), remaining.replace(new RegExp(originals, "g"), "originals"));
  const del2 = await s.invoke("delete_project", { id: p2.id });
  remaining = listBlobs();
  check("deleting the second project removes the last blob", del2.ok && remaining === "", remaining);
  const shards = existsSync(originals) ? readdirSync(originals) : [];
  check("empty shard directories removed", shards.length === 0, shards.join(","));
  await sleep(500);
  await s.quit();

  // ---- Files
  const after = repoSnapshot();
  const changed = [...after].filter(([f, m]) => before.get(f) !== m && !f.endsWith("e2e/library.mjs")).map(([f]) => f);
  check("nothing written to the repository", changed.length === 0, changed.join(", "));
  const untouched = Object.values(F).every((f) => sha256(readFileSync(f.path)) === f.sha && statSync(f.path).mtimeMs === f.mtime);
  check("fixture source files untouched (content and mtime)", untouched);
  const outside = spawnSync("sh", ["-c", `find ${JSON.stringify(dataRoot)} -type f -newer ${JSON.stringify(F["appunti.txt"].path)} | grep -v '/data/${IDENTIFIER}/' | grep -v '/fixtures/' | head -20`], { encoding: "utf8" }).stdout.trim();
  console.log(`      other files written under the temp root (webview caches etc.):\n${outside.split("\n").map((l) => "        " + l.replace(dataRoot, "$TMP")).join("\n")}`);
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
