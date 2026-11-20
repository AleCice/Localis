// Native end-to-end test of v0.4 «Cloud opzionale» (Model Mesh + PRISM): drives the real Localis
// desktop app (WebKitGTK webview + real SQLite + real embedder + real keychain through Secret
// Service) through tauri-driver / WebKitWebDriver, against two kinds of loopback TEST FIXTURES:
//   - e2e/fake-lmstudio.mjs  imitates LM Studio's HTTP API;
//   - e2e/fake-cloud.mjs     imitates the wire shapes of OpenAI, Anthropic, Gemini, DeepSeek and
//                             Qwen (one server each), recording every request.
// Neither is a model, and neither is the real provider API: this test proves Localis' plumbing
// (consent, binding preview, payload = preview, no fallback, PRISM, cloud embeddings consent,
// keychain, request log, persistence), never compatibility with the real services, their
// prices or their models. Plain Node >= 22, no dependencies.
//
// Providers are pointed at the fakes with LOCALIS_TEST_<PROVIDER>_BASE_URL, which only DEBUG
// builds honour (the override is compiled out of release builds).
//
// Prerequisites (Linux): as e2e/chat.mjs, plus for the real keychain path:
//   dbus-daemon, gnome-keyring-daemon, secret-tool (Debian/Ubuntu: dbus, gnome-keyring, libsecret-tools)
// The script starts a PRIVATE session bus and a PRIVATE gnome-keyring (in its temp dir, test-only
// password) so nothing touches the user's real keychain. Without them it still runs the
// keyring_unavailable checks and skips what needs stored keys.
//
// Run:   node e2e/cloud.mjs
// Environment (optional): LOCALIS_BIN, TAURI_DRIVER, E2E_PORT (default 4474), E2E_ARTIFACTS, E2E_KEEP=1
//
// Keys used are obvious sentinels («sk-TEST-SENTINEL-…»); they are never printed.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, PROVIDERS, sha8, startFakeCloud } from "./fake-cloud.mjs";
import { CHAT_MODEL, EMBEDDING_MODEL, startFakeLmStudio } from "./fake-lmstudio.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.LOCALIS_BIN ?? join(REPO, "target/debug/localis");
const PORT = Number(process.env.E2E_PORT ?? 4474);
const ARTIFACTS = process.env.E2E_ARTIFACTS ? resolve(process.env.E2E_ARTIFACTS) : null;
const IDENTIFIER = "app.localis.desktop";
const ENTER = "";
const ESCAPE = "";
const NAMES = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini", deepseek: "DeepSeek", qwen: "Qwen (Alibaba Cloud)" };
const HOSTS = { openai: "api.openai.com", anthropic: "api.anthropic.com", gemini: "generativelanguage.googleapis.com", deepseek: "api.deepseek.com", qwen: "dashscope-intl.aliyuncs.com" };
const KEYS = Object.fromEntries(PROVIDERS.map((p) => [p, `sk-TEST-SENTINEL-${p}-${randomBytes(8).toString("hex")}`]));
const ref = (provider, model) => ({ provider, model });
const lm = (model) => ref("lmstudio", model);

function findDriver() {
  if (process.env.TAURI_DRIVER) return process.env.TAURI_DRIVER;
  const which = spawnSync("sh", ["-c", "command -v tauri-driver"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return join(homedir(), ".cargo/bin/tauri-driver");
}
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

// ---------- reporting ----------
const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok: !!ok });
  let text = typeof info === "string" ? info : JSON.stringify(info);
  for (const k of Object.values(KEYS)) text = text.split(k).join("[SENTINEL]"); // never print a key
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? `  (${text.slice(0, 700)})` : ""}`);
}
const notes = [];
function note(text) {
  notes.push(text);
  console.log(`NOTE  ${text}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- W3C WebDriver client (as in e2e/chat.mjs) ----------
const BASE = `http://127.0.0.1:${PORT}`;
async function wd(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.value && json.value.error)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
  return json.value;
}
const ELEMENT = "element-6066-11e4-a07c-4f15c3e2a2d1";
const elRef = (v) => v[ELEMENT] ?? v.ELEMENT ?? Object.values(v)[0];
let APP_LAUNCHER = null;

class Session {
  static async start() {
    const value = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: APP_LAUNCHER } } } });
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
    return elRef(await wd("POST", this.p("/element"), { using: "css selector", value: css }));
  }
  async findByText(tag, text) {
    return elRef(await wd("POST", this.p("/element"), { using: "xpath", value: `//${tag}[normalize-space(.)=${JSON.stringify(text)}]` }));
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
      writeFileSync(join(ARTIFACTS, `cloud-${name}.png`), Buffer.from(await wd("GET", this.p("/screenshot")), "base64"));
    } catch (e) {
      console.log(`      (screenshot ${name} failed: ${e.message.slice(0, 120)})`);
    }
  }
  async waitFor(expr, desc, timeout = 20000) {
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
    throw new Error(`timeout waiting for: ${desc} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
  }
  invoke(cmd, args) {
    return this.execAsync(
      `const done = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: true, value: v }), (e) => done({ ok: false, err: e }));`,
      [cmd, args ?? {}],
    );
  }
  async must(cmd, args) {
    const r = await this.invoke(cmd, args);
    if (!r.ok) throw new Error(`${cmd}: ${JSON.stringify(r.err)}`);
    return r.value;
  }
  sendRaw(input) {
    return this.execAsync(
      `const done = arguments[arguments.length - 1];
       const events = [];
       const id = window.__TAURI_INTERNALS__.transformCallback((raw) => { if (raw && 'message' in raw) events.push(raw.message.type); });
       window.__TAURI_INTERNALS__.invoke('send_message', { input: arguments[0], onEvent: '__CHANNEL__:' + id }).then(
         (v) => done({ ok: true, value: v, events }), (e) => done({ ok: false, err: e, events }));`,
      [input],
    );
  }
  importText(projectId, name, text) {
    return this.execAsync(
      `const done = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke('import_document', new Uint8Array(arguments[0]), { headers: arguments[1] }).then((v) => done({ ok: true, value: v }), (e) => done({ ok: false, err: e }));`,
      [[...Buffer.from(text, "utf8")], { "x-project-id": projectId, "x-folder-id": "", "x-file-name": name, "x-last-modified": "" }],
    );
  }
}

// ---------- processes ----------
let driver;
let dataRoot;
let fakeLm;
let fakeCloud;
let dbus = null; // { pid, address }
let keyringOk = false;
const extraPids = [];

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
function baseEnv() {
  return {
    ...process.env,
    HOME: join(dataRoot, "home"),
    XDG_DATA_HOME: join(dataRoot, "data"),
    XDG_CONFIG_HOME: join(dataRoot, "config"),
    XDG_CACHE_HOME: join(dataRoot, "cache"),
    XDG_STATE_HOME: join(dataRoot, "state"),
    XDG_RUNTIME_DIR: join(dataRoot, "run"),
    TMPDIR: dataRoot,
  };
}
/** Private session bus + gnome-keyring with an unlocked "login" collection (test-only password). */
function startKeyring() {
  if (!has("dbus-daemon") || !has("gnome-keyring-daemon") || !has("secret-tool")) return false;
  const env = baseEnv();
  const out = spawnSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], { env, encoding: "utf8" });
  const [address, pid] = out.stdout.trim().split("\n");
  if (!address || !pid) return false;
  dbus = { address, pid: Number(pid) };
  const kenv = { ...env, DBUS_SESSION_BUS_ADDRESS: address };
  spawnSync("gnome-keyring-daemon", ["--login"], { env: kenv, input: "qa-test-only", encoding: "utf8" });
  spawnSync("gnome-keyring-daemon", ["--start", "--components=secrets"], { env: kenv, encoding: "utf8" });
  const probe = spawnSync("secret-tool", ["store", "--label=probe", "qa", "probe"], { env: kenv, input: "probe", encoding: "utf8" });
  return probe.status === 0;
}
function secretLookup(provider) {
  if (!dbus) return null;
  const r = spawnSync("secret-tool", ["lookup", "service", IDENTIFIER, "username", provider], { env: { ...baseEnv(), DBUS_SESSION_BUS_ADDRESS: dbus.address }, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
async function startDriver() {
  const env = { ...baseEnv(), WEBKIT_DISABLE_COMPOSITING_MODE: process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? "1" };
  if (dbus) env.DBUS_SESSION_BUS_ADDRESS = dbus.address;
  else env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(dataRoot, "no-bus")}`;
  const driverBin = findDriver();
  const args = ["--port", String(PORT), "--native-port", String(PORT + 1)];
  const [cmd, cmdArgs] = process.env.DISPLAY ? [driverBin, args] : ["xvfb-run", ["-a", driverBin, ...args]];
  driver = spawn(cmd, cmdArgs, { env, cwd: dataRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = ARTIFACTS ? createWriteStream(join(ARTIFACTS, "cloud-driver.log")) : null;
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
function appPids() {
  const out = spawnSync("pgrep", ["-f", BIN], { encoding: "utf8" }).stdout.trim();
  return out ? out.split("\n").map(Number).filter((p) => p !== process.pid) : [];
}
function appConnections() {
  const out = spawnSync("lsof", ["-nP", "-iTCP"], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").filter((l) => /^(localis|WebKit)/.test(l) && l.includes("->")).map((l) => l.match(/->(\S+)/)[1]);
}
async function killApp() {
  for (const pid of appPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await sleep(800);
}
async function cleanup() {
  await stopDriver();
  await killApp();
  if (fakeLm) await fakeLm.close().catch(() => {});
  if (fakeCloud) await fakeCloud.close().catch(() => {});
  if (dbus) {
    // gnome-keyring-daemon processes started on our private bus.
    const out = spawnSync("pgrep", ["-f", "gnome-keyring-daemon"], { encoding: "utf8" }).stdout.trim();
    for (const pid of out ? out.split("\n").map(Number) : []) {
      const env = (() => {
        try {
          return readFileSync(`/proc/${pid}/environ`, "utf8");
        } catch {
          return "";
        }
      })();
      if (env.includes(dataRoot)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
    try {
      process.kill(dbus.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  for (const pid of extraPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  if (dataRoot && process.env.E2E_KEEP !== "1") rmSync(dataRoot, { recursive: true, force: true });
  else if (dataRoot) console.log(`data kept in ${dataRoot}`);
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

// ---------- page helpers ----------
const INSTRUMENT = `
  if (!window.__qa) {
    window.__qa = { csp: [], errors: [], fetches: [], ipc: [], previews: [] };
    document.addEventListener('securitypolicyviolation', (e) => window.__qa.csp.push(e.violatedDirective + ' ' + e.blockedURI));
    window.addEventListener('error', (e) => window.__qa.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__qa.errors.push('rejection: ' + String(e.reason && (e.reason.message || JSON.stringify(e.reason)))));
    const origFetch = window.fetch;
    window.fetch = function (u) { window.__qa.fetches.push(String(u && u.url || u)); return origFetch.apply(this, arguments); };
    const XO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { window.__qa.fetches.push('xhr ' + String(u)); return XO.apply(this, arguments); };
    // invoke() is non-writable; every IPC response goes through the (debug-exposed) callback map.
    const cbs = window.__TAURI_INTERNALS__.callbacks; const set = cbs.set.bind(cbs);
    cbs.set = function (id, fn) {
      return set(id, function (data) {
        try { const j = JSON.stringify(data); if (j) window.__qa.ipc.push(j.slice(0, 20000));
          if (data && typeof data === 'object' && 'token' in data && 'totalChars' in data && 'route' in data) window.__qa.previews.push(data); } catch {}
        return fn.apply(this, arguments);
      });
    };
  }
  return true;`;
async function openApp() {
  const s = await Session.start();
  await s.waitFor(`document.querySelector('.onboarding, .empty, .project-list, .banner-error, .projects')`, "projects view loaded");
  await s.exec(INSTRUMENT);
  return s;
}
async function nav(s, label, ready) {
  await s.click(await s.findByText("button[contains(@class,'nav-item')]", label));
  await s.waitFor(ready, `${label} view`);
}
const goChat = (s) => nav(s, "Chat", `document.querySelector('#chat-composer-input') && !document.querySelector('.view-slot[hidden] #chat-composer-input')`);
const goSettings = (s) => nav(s, "Impostazioni", `document.querySelector('.cloud-settings') && !document.querySelector('.view-slot[hidden] .cloud-settings')`);
const goProjects = (s) => nav(s, "Progetti", `document.querySelector('.projects') && !document.querySelector('.view-slot[hidden] .projects')`);
async function selectProject(s, id) {
  await goProjects(s);
  await s.click(await s.find(`#project-option-${id}`));
  await s.waitFor(`document.querySelector('#project-detail-title') && document.querySelector('.project-cloud')`, "project detail");
}
const ANSWERS = `document.querySelectorAll('.chat-log .msg-assistant:not([aria-busy="true"])').length`;
const IDLE = `(!document.querySelector('.chat-log [aria-busy="true"]') && ![...document.querySelectorAll('.composer button')].some(b => b.textContent.includes('Interrompi')))`;
const DIALOG = `document.querySelector('dialog[open].cloud-send')`;
async function typeQuestion(s, text) {
  const box = await s.find("#chat-composer-input");
  await s.exec(`const i = document.querySelector('#chat-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await s.type(box, text);
  await s.keys(ENTER);
}
/** Asks via the UI; returns the dialog facts when the confirmation dialog appears, or the answer. */
async function askUi(s, text, { timeout = 30000 } = {}) {
  const before = await s.exec(`return ${ANSWERS};`);
  await typeQuestion(s, text);
  const what = await s.waitFor(`${DIALOG} ? 'dialog' : (${ANSWERS} >= ${before + 1} && ${IDLE}) ? 'answer' : (document.querySelector('.chat-log .banner-error, .chat .banner-error') && ${IDLE}) ? 'error' : false`, `outcome of «${text}»`, timeout);
  if (what === "dialog") return { dialog: await dialogFacts(s), before };
  await sleep(200);
  return { answer: await lastAnswer(s), banner: await bannerText(s), before };
}
function dialogFacts(s) {
  return s.exec(`const d = document.querySelector('dialog[open].cloud-send'); if (!d) return null;
    const facts = {}; d.querySelectorAll('.consent-facts > div').forEach(x => facts[x.querySelector('dt').textContent.trim()] = x.querySelector('dd').textContent.replace(/\\s+/g, ' ').trim());
    return { title: d.querySelector('.dialog-title').textContent.trim(), facts, sources: [...d.querySelectorAll('.send-sources li')].map(l => l.textContent.replace(/\\s+/g, ' ').trim()),
      notice: d.querySelector('.notice')?.textContent.trim() ?? null, focus: document.activeElement?.textContent.trim(), focusInDialog: d.contains(document.activeElement),
      buttons: [...d.querySelectorAll('.dialog-actions button')].map(b => b.textContent.trim()), text: d.textContent.replace(/\\s+/g, ' ') };`);
}
async function dialogButton(s, label) {
  await s.click(await s.findByText("dialog[@open]//div[contains(@class,'dialog-actions')]/button", label));
}
async function waitAnswerAfter(s, before, timeout = 30000) {
  await s.waitFor(`${ANSWERS} >= ${before + 1} && ${IDLE} && !${DIALOG}`, "answer after confirm", timeout);
  await sleep(200);
  return lastAnswer(s);
}
function lastAnswer(s) {
  return s.exec(`const all = document.querySelectorAll('.chat-log .msg-assistant'); const a = all[all.length - 1]; if (!a) return null;
    return { cls: a.className, text: a.textContent.replace(/\\s+/g, ' ').trim(), errorText: a.querySelector('.msg-error')?.textContent.replace(/\\s+/g, ' ').trim() ?? null, modelLine: a.querySelector('.msg-model')?.textContent.trim() ?? null };`);
}
function bannerText(s) {
  return s.exec(`const b = document.querySelector('.view-chat .banner-error, .chat .banner-error'); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null;`);
}
async function announcement(s) {
  return s.exec(`return [...document.querySelectorAll('[role=status], [aria-live]')].map(x => x.textContent.trim()).filter(Boolean).join(' | ');`);
}
async function setInput(s, css, value) {
  await s.exec(`const i = document.querySelector(arguments[0]); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true }));`, [css]);
  await s.type(await s.find(css), value);
}
async function setSelectByLabel(s, scope, label, value) {
  return s.exec(
    `const l = [...document.querySelectorAll(arguments[0] + ' label')].find(x => x.textContent.trim() === arguments[1]);
     const sel = l && l.control; if (!sel || sel.disabled) return 'missing-or-disabled';
     if (![...sel.options].some(o => o.value === arguments[2] && !o.disabled)) return 'no-option:' + [...sel.options].map(o => o.value + (o.disabled ? '(off)' : '')).join(',');
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, arguments[2]);
     sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value;`,
    [scope, label, value],
  );
}
function settings(baseUrl, over = {}) {
  return { baseUrl, chatModel: null, embeddingModel: null, routing: "manual", autoModels: [], ...over };
}
function fileTree(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.push(...fileTree(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

// ---------- fixtures ----------
const DOC_A = "Il catalogo delle stelle fu misurato con un astrolabio di ottone.\n\nL'astrolabio permette di misurare l'altezza degli astri sull'orizzonte.\n";
const DOC_B = "Il vento zefiro soffia da ponente in primavera.\n\nI marinai attendevano lo zefiro per salpare verso occidente.\n";
const DOC_PRIVATE = "Segreto locale: il quaderno riservato parla del giacinto blu e del giacinto bianco.\n\nIl giacinto fiorisce in aprile.\n";

// ---------- scenario ----------
async function main() {
  if (!existsSync(BIN)) throw new Error(`app binary not found: ${BIN}`);
  if (ARTIFACTS) mkdirSync(ARTIFACTS, { recursive: true });
  dataRoot = mkdtempSync(join(tmpdir(), "localis-e2e-cloud-"));
  for (const d of ["home", "data", "config", "cache", "state", "run"]) mkdirSync(join(dataRoot, d), { recursive: true, mode: 0o700 });
  const appDir = join(dataRoot, "data", IDENTIFIER);
  const stderrLog = join(dataRoot, "app-stderr.log");
  const noKeyringFlag = join(dataRoot, "no-keyring");

  keyringOk = startKeyring();
  check("private Secret Service (gnome-keyring on a private session bus) available for the test", keyringOk, keyringOk ? "" : "falling back to keyring_unavailable checks only");

  const lmPort = await freePort();
  const lmUrl = `http://127.0.0.1:${lmPort}`;
  const lmRecord = join(ARTIFACTS ?? dataRoot, "cloud-fake-lmstudio.jsonl");
  fakeLm = await startFakeLmStudio({ port: lmPort, recordFile: lmRecord });
  fakeCloud = await startFakeCloud({ keys: KEYS, recordFile: join(ARTIFACTS ?? dataRoot, "cloud-fake-cloud.jsonl") });
  // Launcher: test overrides (debug builds only), dead proxies for every scheme (an app that used
  // a proxy for the loopback fakes would fail), stderr/stdout captured for the key grep.
  APP_LAUNCHER = join(dataRoot, "launch.sh");
  const envLines = Object.entries(fakeCloud.env).map(([k, v]) => `export ${k}=${v}`).join("\n");
  writeFileSync(APP_LAUNCHER, `#!/bin/sh
${envLines}
export HTTP_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9 NO_PROXY= no_proxy= GIO_USE_PROXY_RESOLVER=dummy
if [ -e ${JSON.stringify(noKeyringFlag)} ]; then export DBUS_SESSION_BUS_ADDRESS=unix:path=${join(dataRoot, "no-bus")}; fi
exec ${JSON.stringify(BIN)} "$@" >>${JSON.stringify(stderrLog)} 2>&1
`, { mode: 0o755 });
  await startDriver();
  const netSamples = [];
  const sampleNet = () => netSamples.push(...appConnections());
  const cloudCount = () => fakeCloud.requests.length;

  let s = await openApp();
  // ---- New project is «Solo locale»
  await s.click(await s.findByText("button", "Crea il primo progetto"));
  await s.waitFor(`document.activeElement?.id === 'project-name'`, "create dialog");
  await s.type(await s.find("#project-name"), "Cloud E2E");
  await s.click(await s.findByText("dialog[@open]//button", "Crea progetto"));
  await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.project-option')`, "project created");
  let projects = await s.must("list_projects");
  const P1 = projects[0];
  check("new project (UI) is «Solo locale» without embedding consent", P1.cloudPolicy === "local_only" && P1.cloudEmbeddingConsent === false, P1);
  const P2 = await s.must("create_project", { input: { name: "Riservato locale" } });
  check("new project (command) is «Solo locale»", P2.cloudPolicy === "local_only" && P2.cloudEmbeddingConsent === false, P2);
  const imps = [await s.importText(P1.id, "astrolabio.txt", DOC_A), await s.importText(P1.id, "zefiro.txt", DOC_B), await s.importText(P2.id, "quaderno.txt", DOC_PRIVATE)];
  check("fixtures imported", imps.every((r) => r.ok), imps.map((r) => r.ok || JSON.stringify(r.err)));
  for (let i = 0; i < 60; i++) {
    const all = [...(await s.must("list_documents", { projectId: P1.id })), ...(await s.must("list_documents", { projectId: P2.id }))];
    if (all.every((d) => d.current.textStatus === "extracted")) break;
    await sleep(250);
  }
  await s.must("set_llm_settings", { settings: settings(lmUrl) });
  await selectProject(s, P1.id);
  const policyUi = await s.exec(`return [...document.querySelectorAll('.cloud-policy input[type=radio]')].map(r => r.checked + ':' + r.closest('label').textContent.trim().slice(0, 30));`);
  check("project detail «Uso del cloud»: «Solo locale» checked by default", /^true:Solo locale/.test(policyUi[0] ?? "") && /^false:Consenti cloud/.test(policyUi[1] ?? ""), policyUi);

  // ---- Keychain status and keys through the UI
  await goSettings(s);
  const ks = await s.must("get_keyring_status");
  check("get_keyring_status: available with the private Secret Service", keyringOk ? ks.available === true : ks.available === false, ks);
  const provs0 = await s.must("list_providers");
  check("list_providers: five providers, fixed hosts, no keys yet, capabilities", provs0.length === 5 && provs0.every((p) => p.host === HOSTS[p.id] && p.name === NAMES[p.id] && p.hasKey === false && p.supportsChat) &&
    provs0.filter((p) => p.supportsEmbeddings).map((p) => p.id).join() === "openai,gemini,qwen", provs0.map((p) => `${p.id}:${p.host}:${p.supportsEmbeddings}`));
  const field = await s.exec(`const i = document.querySelector('#api-key-openai'); return i ? { type: i.type, label: i.labels[0]?.textContent.trim(), ac: i.autocomplete, disabled: i.disabled } : null;`);
  check("OpenAI key field: password input with a label, autocomplete off", field?.type === "password" && field.label === "Chiave API di OpenAI" && field.ac === "off" && !field.disabled, field);
  // Invalid key (space) → validation at the field, value not echoed.
  await s.type(await s.find("#api-key-openai"), "sk-TEST bad");
  await s.click(await s.find("#api-key-openai ~ button[type=submit]"));
  const badKey = await s.waitFor(`document.querySelector('#api-key-openai-error')?.textContent.trim()`, "key error");
  check("key with a space → validation message (key not echoed), nothing stored", /chiave API non è valida/i.test(badKey) && !badKey.includes("sk-TEST") && !(await s.must("list_providers")).find((p) => p.id === "openai").hasKey, badKey);
  await setInput(s, "#api-key-openai", KEYS.openai);
  await s.click(await s.find("#api-key-openai ~ button[type=submit]"));
  if (keyringOk) {
    await s.waitFor(`!document.querySelector('#api-key-openai') && [...document.querySelectorAll('.provider')].some(p => p.textContent.includes('OpenAI') && p.textContent.includes('Chiave salvata nel portachiavi'))`, "key saved");
    const html = await s.exec(`return document.documentElement.outerHTML;`);
    check("after saving: form gone, «Chiave salvata nel portachiavi», key not in the DOM", !html.includes(KEYS.openai));
    const ann = await announcement(s);
    check("save announced to screen readers", ann.includes("Chiave di OpenAI salvata nel portachiavi."), ann);
    const stored = secretLookup("openai");
    check("key stored in Secret Service (service app.localis.desktop, account openai), byte-equal", stored === KEYS.openai, stored === null ? "lookup failed" : `len ${stored.length} sha8 ${sha8(stored)}`);
    for (const p of PROVIDERS.filter((x) => x !== "openai")) {
      const r = await s.invoke("set_api_key", { provider: p, key: `  ${KEYS[p]}  ` });
      check(`set_api_key ${p} (trimmed) → hasKey, response carries no key`, r.ok && r.value.hasKey === true && !JSON.stringify(r).includes(KEYS[p]) && secretLookup(p) === KEYS[p], r.ok ? r.value : r.err);
    }
  } else {
    const err = await s.waitFor(`document.querySelector('#api-key-openai-error')?.textContent.trim() || document.querySelector('.keyring-off')?.textContent.trim()`, "keyring error");
    check("no Secret Service → keyring_unavailable shown, nothing stored", /portachiavi/i.test(err), err);
  }
  const bogus = await s.invoke("set_api_key", { provider: "openrouter", key: "sk-TEST-x" });
  check("set_api_key unknown provider → validation", !bogus.ok && bogus.err.code === "validation", bogus.err);
  if (!keyringOk) throw new Error("no Secret Service: the remaining scenario needs stored keys");

  // ---- «Carica modelli»
  const n0 = cloudCount();
  await s.click(await s.findByText("section[contains(@class,'provider')][.//h3[normalize-space(.)='OpenAI']]//button", "Carica modelli"));
  const listed = await s.waitFor(`(() => { const sec = [...document.querySelectorAll('section.provider')].find(p => p.querySelector('h3').textContent.trim() === 'OpenAI'); const ids = [...sec.querySelectorAll('.provider-model-id')].map(x => x.textContent + '|' + x.nextElementSibling?.textContent); return ids.length ? ids : false; })()`, "models listed");
  const lmReq = fakeCloud.requests.slice(n0);
  check("«Carica modelli» lists the fake OpenAI models with kinds", listed.some((x) => x.startsWith(`${MODELS.openai.chat}|`)) && listed.some((x) => x.startsWith(`${MODELS.openai.embedding}|`) && x.includes("embedding")), listed);
  check("«Carica modelli» sends exactly one GET /v1/models to OpenAI with Bearer auth, nothing else", lmReq.length === 1 && lmReq[0].provider === "openai" && lmReq[0].method === "GET" && lmReq[0].path === "/v1/models" && lmReq[0].auth.header === "authorization" && lmReq[0].auth.ok && lmReq[0].body === null,
    lmReq.map((r) => `${r.provider} ${r.method} ${r.path} ${r.auth.header} ${r.auth.ok}`));
  let log = await s.must("list_cloud_requests", { limit: 100 });
  check("list_cloud_requests logs list_models (provider openai, 0 chars, ok)", log.length === 1 && log[0].purpose === "list_models" && log[0].provider === "openai" && log[0].charsSent === 0 && log[0].ok === true && log[0].model === null, log);
  for (const p of ["anthropic", "gemini", "deepseek", "qwen"]) {
    const m = await s.must("list_provider_models", { provider: p });
    const r = fakeCloud.requests.at(-1);
    check(`list_provider_models ${p}: fake models, kinds, correct auth header`, m.reachable && m.models.some((x) => x.id === MODELS[p].chat) &&
      (p !== "gemini" || (m.models.find((x) => x.id === MODELS.gemini.embedding)?.kind === "embedding" && m.models.find((x) => x.id === MODELS.gemini.chat)?.kind === "llm")) &&
      r.provider === p && r.auth.ok && r.auth.header === ({ anthropic: "x-api-key", gemini: "x-goog-api-key" }[p] ?? "authorization") &&
      (p !== "anthropic" || r.anthropicVersion === "2023-06-01"), `${JSON.stringify(m.models)} via ${r.auth.header}`);
  }
  // Chat model: OpenAI, via the settings select (the loaded models appear in the «Cloud» group).
  const pick = await setSelectByLabel(s, ".models-settings", "Modello di chat", `openai:${MODELS.openai.chat}`);
  await sleep(500);
  let st = await s.must("get_llm_settings");
  check("cloud chat model chosen in Impostazioni (group «Cloud»), saved as ModelRef", (pick === `openai:${MODELS.openai.chat}` || pick === "") && st.chatModel?.provider === "openai" && st.chatModel.model === MODELS.openai.chat, { pick, st });
  await s.screenshot("01-settings-keys");

  // ---- Local-only project + cloud model → nothing sent, guidance shown
  await goChat(s);
  const indicator = await s.exec(`return document.querySelector('.chat-header .model-state')?.textContent.trim() ?? null;`);
  check("chat header in a local-only project: «Cloud non consentito in questo progetto»", indicator === "Cloud non consentito in questo progetto", indicator);
  const optLocalOnly = await s.exec(`return [...document.querySelectorAll('.chat-header .model-picker option')].filter(o => o.value.startsWith('openai:')).map(o => o.disabled + '|' + o.textContent);`);
  check("chat picker: cloud models disabled with reason «progetto solo locale»", optLocalOnly.length > 0 && optLocalOnly.every((o) => o.startsWith("true|") && o.includes("progetto solo locale")), optLocalOnly);
  let n1 = cloudCount();
  let lm1 = fakeLm.requests.filter((r) => r.path === "/v1/chat/completions").length;
  let out = await askUi(s, "Parlami dell'astrolabio");
  check("local-only project: no dialog, guidance «Solo locale» + «Progetti → Uso del cloud»", !out.dialog && /Solo locale/.test(out.banner ?? "") && /Progetti → Uso del cloud/.test(out.banner ?? "") && /Nulla è stato inviato/.test(out.banner ?? ""), out.banner);
  check("local-only project: NOTHING reached any fake provider, nor LM Studio chat", cloudCount() === n1 && fakeLm.requests.filter((r) => r.path === "/v1/chat/completions").length === lm1, fakeCloud.requests.slice(n1).map((r) => r.path));
  let convs = await s.must("list_conversations", { projectId: P1.id });
  let stored = convs.length ? await s.must("list_messages", { conversationId: convs[0].id }) : [];
  check("local-only project: nothing stored for the refused question", stored.length === 0, stored.length);
  const conv0 = convs[0] ?? (await s.must("create_conversation", { projectId: P1.id }));
  const pr = await s.invoke("prepare_cloud_send", { input: { conversationId: conv0.id, text: "Parlami dell'astrolabio" } });
  const sm = await s.sendRaw({ conversationId: conv0.id, text: "Parlami dell'astrolabio" });
  check("local-only (invoke): prepare_cloud_send and send_message → consent_required, nothing sent", !pr.ok && pr.err.code === "consent_required" && !sm.ok && sm.err.code === "consent_required" && cloudCount() === n1, { pr: pr.err, sm: sm.err });
  await s.screenshot("02-local-only");

  // ---- Allow the cloud in P1 (confirmation dialog)
  await selectProject(s, P1.id);
  await s.exec(`[...document.querySelectorAll('.cloud-policy input[type=radio]')][1].click();`);
  const cd = await s.waitFor(`document.querySelector('dialog[open]')?.textContent.includes('Consentire il cloud') && document.querySelector('dialog[open]').textContent.replace(/\\s+/g,' ')`, "cloud policy dialog");
  check("«Consenti cloud» asks for confirmation first", /Consentire il cloud per «Cloud E2E»\?/.test(cd), cd.slice(0, 300));
  await s.click(await s.findByText("dialog[@open]//button", "Consenti cloud"));
  await s.waitFor(`!document.querySelector('dialog[open]')`, "dialog closed");
  projects = await s.must("list_projects");
  check("P1 now cloud_allowed (P2 unchanged)", projects.find((p) => p.id === P1.id).cloudPolicy === "cloud_allowed" && projects.find((p) => p.id === P2.id).cloudPolicy === "local_only");
  check("enabling the cloud sent nothing", cloudCount() === n1);

  // ---- Ask → binding preview dialog → Annulla / Esc
  await goChat(s);
  const ind2 = await s.exec(`return document.querySelector('.chat-header .model-state')?.textContent.trim() ?? null;`);
  check("chat header indicator «Cloud: OpenAI · <model>»", ind2 === `Cloud: OpenAI · ${MODELS.openai.chat}`, ind2);
  n1 = cloudCount();
  out = await askUi(s, "Parlami dell'astrolabio");
  const d1 = out.dialog;
  check("confirmation dialog appears before anything is sent", !!d1 && cloudCount() === n1, d1?.title);
  check("dialog: title, provider + host, model, reason", d1.title === "Inviare la domanda a OpenAI?" && d1.facts.Provider === "OpenAI · api.openai.com" && d1.facts.Modello === MODELS.openai.chat && d1.facts["Scelta del modello"] === "Scelto manualmente nelle impostazioni.", d1.facts);
  check("dialog: question, sources with titles and units, no history", d1.facts["Cosa viene inviato"].includes("Parlami dell'astrolabio") && d1.sources.length >= 1 && d1.sources.every((x) => /^\[\d+\] (astrolabio|zefiro)\.txt, blocco \d+ · [\d.]+ caratteri$/.test(x)) && /Nessuno scambio precedente/.test(d1.facts["Cosa viene inviato"]), d1.sources);
  check("dialog: characters, estimated tokens, max output 2048, cost «non stimabile» without a price", /caratteri · circa [\d.]+ token in ingresso \(stima\) · al massimo 2\.048 token in uscita/.test(d1.facts.Dimensione) && d1.facts["Costo stimato"] === "Costo non stimabile: imposta il prezzo in Impostazioni", d1.facts);
  check("dialog: initial focus on «Annulla»; buttons «Annulla» / «Invia a OpenAI»", d1.focus === "Annulla" && d1.focusInDialog && d1.buttons.join("|") === "Annulla|Invia a OpenAI", d1);
  let prev = (await s.exec(`return window.__qa.previews;`)).filter(Boolean).at(-1);
  check("dialog numbers = CloudPreview (sources, chars, tokens)", d1.sources.length === prev.sources.length && d1.facts.Dimensione.replace(/\./g, "").startsWith(`${prev.totalChars} caratteri`) && prev.estInputTokens === Math.ceil(prev.totalChars / 4) && prev.maxOutputTokens === 2048 && prev.estCost === null && prev.queryEmbeddedBy === null && prev.host === "api.openai.com",
    { totalChars: prev.totalChars, est: prev.estInputTokens, dim: d1.facts.Dimensione });
  check("CloudPreview carries no key", !JSON.stringify(prev).includes("sk-TEST"));
  await s.screenshot("03-confirm-dialog");
  await dialogButton(s, "Annulla");
  await s.waitFor(`!${DIALOG} && ${IDLE}`, "dialog closed");
  await sleep(500);
  convs = await s.must("list_conversations", { projectId: P1.id });
  let msgsAll = (await Promise.all(convs.map((c) => s.must("list_messages", { conversationId: c.id })))).flat();
  const draftBack = await s.exec(`return document.querySelector('#chat-composer-input').value;`);
  check("«Annulla»: nothing sent, nothing stored, question back in the composer, announced", cloudCount() === n1 && msgsAll.length === 0 && draftBack === "Parlami dell'astrolabio" && (await announcement(s)).includes("Invio annullato: nulla è stato inviato a OpenAI."), { sent: cloudCount() - n1, stored: msgsAll.length, draftBack });
  const reuseCancelled = await s.sendRaw({ conversationId: convs[0]?.id ?? conv0.id, text: "Parlami dell'astrolabio", confirmToken: prev.token });
  check("token of a cancelled preview is discarded → consent_required", !reuseCancelled.ok && reuseCancelled.err.code === "consent_required" && cloudCount() === n1, reuseCancelled.err);
  // Esc cancels too.
  await s.exec(`const i = document.querySelector('#chat-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true }));`);
  out = await askUi(s, "Parlami dell'astrolabio");
  await s.keys(ESCAPE);
  await s.waitFor(`!${DIALOG} && ${IDLE}`, "dialog closed by Esc");
  await sleep(400);
  check("Esc closes the dialog and sends nothing", !!out.dialog && cloudCount() === n1);

  // ---- Confirm → streamed answer; request = preview
  await s.exec(`const i = document.querySelector('#chat-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true }));`);
  out = await askUi(s, "Parlami dell'astrolabio");
  prev = (await s.exec(`return window.__qa.previews;`)).filter(Boolean).at(-1);
  const before = out.before;
  await dialogButton(s, "Invia a OpenAI");
  sampleNet();
  let ans = await waitAnswerAfter(s, before);
  sampleNet();
  let reqs = fakeCloud.requests.slice(n1);
  check("confirm → exactly one request, to OpenAI POST /v1/chat/completions", reqs.length === 1 && reqs[0].provider === "openai" && reqs[0].path === "/v1/chat/completions" && reqs[0].auth.ok, reqs.map((r) => `${r.provider} ${r.path}`));
  let body = reqs[0].body;
  const userMsg = body.messages.at(-1).content;
  const tags = [...userMsg.matchAll(/--- (inizio|fine) fonte \[(\d+)\] ([0-9a-f]{12}) ---/g)];
  check("OpenAI body: model, stream, include_usage, max_completion_tokens 2048, NO temperature", body.model === MODELS.openai.chat && body.stream === true && body.stream_options?.include_usage === true && body.max_completion_tokens === 2048 && !("temperature" in body), Object.keys(body));
  check("request = preview: same number of sources, question last, no history", body.messages.length === 2 && body.messages[0].role === "system" && tags.filter((t) => t[1] === "inizio").length === prev.sources.length && userMsg.trim().endsWith("Domanda: Parlami dell'astrolabio"),
    { msgs: body.messages.length, sources: tags.length / 2, preview: prev.sources.length });
  check("request = preview: total characters equal CloudPreview.totalChars", body.messages.reduce((n, m) => n + [...m.content].length, 0) === prev.totalChars, `${body.messages.reduce((n, m) => n + [...m.content].length, 0)} vs ${prev.totalChars}`);
  check("source delimiters carry one random 12-hex tag per request (begin/end pairs)", tags.length === prev.sources.length * 2 && new Set(tags.map((t) => t[3])).size === 1, tags.map((t) => t[3]).slice(0, 2));
  check("request: titles of the sources as in the preview", prev.sources.every((x) => userMsg.includes(`[${x.n}] «${x.title}», blocco ${x.unit}`)));
  convs = await s.must("list_conversations", { projectId: P1.id });
  const convA = convs[0];
  let ms = await s.must("list_messages", { conversationId: convA.id });
  let last = ms.at(-1);
  const usage0 = reqs[0];
  check("stored answer: provider openai, model, routeReason, usage from the provider, cost null (no price)", last.status === "complete" && last.provider === "openai" && last.model === MODELS.openai.chat && last.routeReason === "Scelto manualmente nelle impostazioni." && last.usage?.inputTokens > 0 && last.usage?.outputTokens > 0 && last.cost === null && last.content.includes("server finto openai"),
    { status: last.status, provider: last.provider, usage: last.usage, cost: last.cost });
  check("UI under the answer: «OpenAI · model · tokens», no cost without a price", ans.modelLine?.startsWith(`OpenAI · ${MODELS.openai.chat} · `) && /token in ingresso/.test(ans.modelLine) && !/USD|\$|€/.test(ans.modelLine), ans.modelLine);
  log = await s.must("list_cloud_requests", { limit: 100 });
  check("log: chat entry with project, conversation, chars = preview, usage = stored", log[0].purpose === "chat" && log[0].provider === "openai" && log[0].projectId === P1.id && log[0].conversationId === convA.id && log[0].charsSent === prev.totalChars && log[0].usage.inputTokens === last.usage.inputTokens && log[0].ok, log[0]);
  void usage0;

  // ---- Second question asks again (history in the preview and in the request)
  n1 = cloudCount();
  out = await askUi(s, "E lo zefiro?");
  check("second question → the dialog asks again", !!out.dialog && cloudCount() === n1);
  prev = (await s.exec(`return window.__qa.previews;`)).filter(Boolean).at(-1);
  check("preview: 1 history pair with its characters", prev.historyPairs === 1 && prev.historyChars === [..."Parlami dell'astrolabio"].length + [...last.content].length && /1 scambio precedente della conversazione/.test(out.dialog.facts["Cosa viene inviato"]), { pairs: prev.historyPairs, chars: prev.historyChars });
  await dialogButton(s, "Invia a OpenAI");
  ans = await waitAnswerAfter(s, out.before);
  body = fakeCloud.requests.at(-1).body;
  check("request: system + previous pair + question (as previewed)", body.messages.length === 4 && body.messages[1].content === "Parlami dell'astrolabio" && body.messages[2].content === last.content && body.messages.reduce((n, m) => n + [...m.content].length, 0) === prev.totalChars);

  // ---- Price → cost range in the preview, actual cost on the answer
  await goSettings(s);
  await setInput(s, ".price-form .price-model input", MODELS.openai.chat);
  const sel = await s.exec(`const sel = document.querySelector('.price-form select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'openai'); sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value;`);
  const priceInputs = await s.exec(`return [...document.querySelectorAll('.price-form input')].map(i => i.labels[0]?.textContent.trim());`);
  const byLabel = (label) => s.exec(`const l = [...document.querySelectorAll('.price-form label')].find(x => x.textContent.trim() === arguments[0]); return '#' + CSS.escape(l.htmlFor);`, [label]);
  await setInput(s, await byLabel("Input per milione di token"), "2,5");
  await setInput(s, await byLabel("Output per milione di token"), "10");
  await setInput(s, await byLabel("Valuta"), "USD");
  await s.click(await s.findByText("button", "Salva prezzo"));
  await sleep(700);
  const prices = await s.must("list_prices");
  check("price saved via the form (2,5 / 10 USD per Mtok)", sel === "openai" && prices.length === 1 && prices[0].inputPerMTok === 2.5 && prices[0].outputPerMTok === 10 && prices[0].currency === "USD", { prices, priceInputs });
  await goChat(s);
  out = await askUi(s, "Cosa misura l'astrolabio?");
  prev = (await s.exec(`return window.__qa.previews;`)).filter(Boolean).at(-1);
  const expMin = (prev.estInputTokens * 2.5) / 1e6;
  const expMax = (prev.estInputTokens * 2.5 + 2048 * 10) / 1e6;
  check("preview cost range = est tokens × input price … + 2048 × output price", Math.abs(prev.estCost.min.amount - expMin) < 1e-12 && Math.abs(prev.estCost.max.amount - expMax) < 1e-12 && prev.estCost.min.currency === "USD", { est: prev.estCost, expMin, expMax });
  check("dialog shows «da … a … (stima)»", /^da .*USD|^da .*\$/.test(out.dialog.facts["Costo stimato"]) && out.dialog.facts["Costo stimato"].endsWith("(stima)"), out.dialog.facts["Costo stimato"]);
  await dialogButton(s, "Invia a OpenAI");
  ans = await waitAnswerAfter(s, out.before);
  ms = await s.must("list_messages", { conversationId: convA.id });
  last = ms.at(-1);
  const expCost = (last.usage.inputTokens * 2.5 + last.usage.outputTokens * 10) / 1e6;
  check("answer cost = actual usage × prices", last.cost && Math.abs(last.cost.amount - expCost) < 1e-12 && last.cost.currency === "USD", { usage: last.usage, cost: last.cost, expCost });
  check("UI shows provider · model · actual tokens · cost under the answer", ans.modelLine?.startsWith(`OpenAI · ${MODELS.openai.chat} · `) && ans.modelLine.includes(`${last.usage.inputTokens} token in ingresso`) && /USD|\$/.test(ans.modelLine), ans.modelLine);
  await s.screenshot("04-answer-cost");

  // ---- Every provider family (invoke: prepare → send with token)
  const convB = await s.must("create_conversation", { projectId: P1.id });
  for (const p of ["anthropic", "gemini", "deepseek", "qwen"]) {
    await s.must("set_llm_settings", { settings: settings(lmUrl, { chatModel: ref(p, MODELS[p].chat) }) });
    const n = cloudCount();
    const q = `Parlami dello zefiro (${p})`;
    const pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: q } });
    const r = await s.sendRaw({ conversationId: convB.id, text: q, confirmToken: pv.token });
    const rq = fakeCloud.requests.slice(n);
    const b = rq[0]?.body ?? {};
    let shape = false;
    if (p === "anthropic") shape = rq[0].path === "/v1/messages" && rq[0].auth.header === "x-api-key" && rq[0].anthropicVersion === "2023-06-01" && typeof b.system === "string" && b.max_tokens === 2048 && b.temperature === 0.2 && b.messages.every((m) => m.role !== "system");
    if (p === "gemini") shape = rq[0].path === `/v1beta/models/${MODELS.gemini.chat}:streamGenerateContent` && rq[0].query === "alt=sse" && rq[0].auth.header === "x-goog-api-key" && b.systemInstruction?.parts?.[0]?.text?.length > 0 && b.contents.every((c) => c.role === "user" || c.role === "model") && b.generationConfig.maxOutputTokens === 2048 && b.generationConfig.temperature === 0.2;
    if (p === "deepseek") shape = rq[0].path === "/chat/completions" && rq[0].auth.header === "authorization" && b.temperature === 0.2 && b.max_tokens === 2048 && b.stream_options?.include_usage === true;
    if (p === "qwen") shape = rq[0].path === "/compatible-mode/v1/chat/completions" && rq[0].auth.header === "authorization" && b.temperature === 0.2 && b.max_tokens === 2048;
    const msg = r.value;
    check(`${NAMES[p]}: preview host ${HOSTS[p]}; one request with the provider's wire format; streamed answer with usage`, pv.host === HOSTS[p] && pv.providerName === NAMES[p] && r.ok && rq.length === 1 && rq[0].provider === p && rq[0].auth.ok && shape &&
      msg.status === "complete" && msg.provider === p && msg.content.includes(`server finto ${p}`) && msg.usage?.inputTokens > 0 && msg.usage?.outputTokens > 0 && r.events.includes("delta"),
      { path: rq[0]?.path, keys: Object.keys(b), status: msg?.status, usage: msg?.usage, err: r.err });
  }

  // ---- Errors: 401 / 429 / 500, no fallback
  await s.must("set_llm_settings", { settings: settings(lmUrl, { chatModel: ref("openai", MODELS.openai.chat), autoModels: [lm(CHAT_MODEL), ref("deepseek", MODELS.deepseek.chat)] }) });
  for (const [mode, re] of [["401", /^Chiave API non valida o senza permessi per OpenAI\./], ["429", /^Limite di richieste raggiunto per OpenAI\. Riprova più tardi\./], ["500", /^OpenAI non raggiungibile\./]]) {
    fakeCloud.mode.openai = mode;
    const n = cloudCount();
    const lmChats = fakeLm.requests.filter((r) => r.path === "/v1/chat/completions").length;
    const q = `Domanda con errore ${mode} sull'astrolabio`;
    const pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: q } });
    const r = await s.sendRaw({ conversationId: convB.id, text: q, confirmToken: pv.token });
    const rq = fakeCloud.requests.slice(n);
    const m = r.value;
    check(`HTTP ${mode} → «${re.source.slice(1, 40)}…», error stored, no fallback (one request, only OpenAI, no LM Studio chat)`, r.ok && m.status === "error" && m.error.code === "llm_unavailable" && re.test(m.error.message) && rq.length === 1 && rq[0].provider === "openai" && fakeLm.requests.filter((x) => x.path === "/v1/chat/completions").length === lmChats && !JSON.stringify(m).includes("sk-TEST"),
      { msg: m?.error, hits: rq.map((x) => x.provider) });
  }
  // 401 through the UI: the hint says Localis does not retry elsewhere.
  fakeCloud.mode.openai = "401";
  out = await askUi(s, "Ancora sull'astrolabio, con chiave rifiutata");
  await dialogButton(s, "Invia a OpenAI");
  ans = await waitAnswerAfter(s, out.before);
  check("UI 401: «Chiave API non valida…» + «Localis non riprova con un altro provider»", /Chiave API non valida o senza permessi per OpenAI/.test(ans.errorText ?? ans.text) && /non riprova con un altro provider/.test(ans.text), ans.text.slice(0, 300));
  fakeCloud.mode.openai = "ok";
  log = await s.must("list_cloud_requests", { limit: 100 });
  check("failed requests are logged ok:false with the Italian error (no key, no body)", log.filter((x) => !x.ok).length >= 4 && log.filter((x) => !x.ok).every((x) => x.error && !x.error.includes("sk-TEST") && !x.error.includes("fake:")), log.filter((x) => !x.ok).map((x) => x.error));

  // ---- Token misuse via invoke
  const n2 = cloudCount();
  const msgCount = async (c) => (await s.must("list_messages", { conversationId: c })).length;
  const mc0 = await msgCount(convB.id);
  const tq = "Uso improprio della conferma sull'astrolabio";
  const tries = [];
  tries.push(["no token", await s.sendRaw({ conversationId: convB.id, text: tq })]);
  tries.push(["forged token", await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: "6f1c2a0e-0000-4000-8000-000000000000" })]);
  tries.push(["empty token", await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: "" })]);
  let pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: tq } });
  tries.push(["token for another text", await s.sendRaw({ conversationId: convB.id, text: tq + " (cambiata)", confirmToken: pv.token })]);
  tries.push(["same token after a mismatch (consumed)", await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: pv.token })]);
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: tq } });
  tries.push(["token for another conversation", await s.sendRaw({ conversationId: convA.id, text: tq, confirmToken: pv.token })]);
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: tq } });
  const docs = await s.must("list_documents", { projectId: P1.id });
  tries.push(["token with a different selection", await s.sendRaw({ conversationId: convB.id, text: tq, documentIds: [docs[0].id], confirmToken: pv.token })]);
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: tq } });
  await s.must("set_llm_settings", { settings: settings(lmUrl, { chatModel: ref("deepseek", MODELS.deepseek.chat) }) });
  tries.push(["model changed after the preview", await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: pv.token })]);
  await s.must("set_llm_settings", { settings: settings(lmUrl, { chatModel: ref("openai", MODELS.openai.chat) }) });
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: tq } });
  await s.must("discard_cloud_send", { token: pv.token });
  tries.push(["discarded token", await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: pv.token })]);
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: tq } });
  await s.must("set_project_cloud_policy", { projectId: P1.id, policy: "local_only" });
  tries.push(["project made local-only after the preview", await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: pv.token })]);
  await s.must("set_project_cloud_policy", { projectId: P1.id, policy: "cloud_allowed" });
  for (const [name, r] of tries) check(`send_message with ${name} → consent_required, no events`, !r.ok && r.err.code === "consent_required" && r.events.length === 0, r.ok ? r.value.status : r.err);
  check("token misuse: no provider request, nothing stored", cloudCount() === n2 && (await msgCount(convB.id)) === mc0, { sent: cloudCount() - n2 });
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: tq } });
  let okSend = await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: pv.token });
  const reuse = await s.sendRaw({ conversationId: convB.id, text: tq, confirmToken: pv.token });
  check("valid token works once; reusing it → consent_required (single use)", okSend.ok && okSend.value.status === "complete" && !reuse.ok && reuse.err.code === "consent_required" && cloudCount() === n2 + 1, reuse.err);
  note("token expiry (10 min TTL) not exercised natively (would need a 10-minute wait); covered only by the Rust tests with a short TTL");

  // ---- PRISM automatic routing
  await s.must("set_price", { price: { provider: "deepseek", model: MODELS.deepseek.chat, inputPerMTok: 0.5, outputPerMTok: 1, currency: "USD" } });
  await s.must("set_price", { price: { provider: "gemini", model: MODELS.gemini.chat, inputPerMTok: 0.1, outputPerMTok: 0.3, currency: "USD" } });
  const autoList = [lm(CHAT_MODEL), ref("anthropic", MODELS.anthropic.chat), ref("deepseek", MODELS.deepseek.chat), ref("gemini", MODELS.gemini.chat)];
  await s.must("set_llm_settings", { settings: settings(lmUrl, { routing: "auto", chatModel: ref("openai", MODELS.openai.chat), autoModels: autoList }) });
  await goSettings(s);
  await goChat(s);
  const pickAuto = await s.exec(`return document.querySelector('.chat-header .model-picker select').value;`);
  check("chat picker shows «Automatico»", pickAuto === "auto" && (await s.exec(`const x = document.querySelector('.chat-header .model-picker select'); return x.options[x.selectedIndex].textContent;`)) === "Automatico", pickAuto);
  let n3 = cloudCount();
  out = await askUi(s, "Parlami del catalogo e dell'astrolabio");
  convs = await s.must("list_conversations", { projectId: P1.id });
  ms = await s.must("list_messages", { conversationId: convs[0].id });
  last = ms.at(-1);
  check("PRISM auto, LM Studio up → local model, no dialog, nothing to the cloud, reason stored", !out.dialog && cloudCount() === n3 && last.provider === "lmstudio" && last.model === CHAT_MODEL && /Scelto automaticamente: .* disponibile in LM Studio/.test(last.routeReason ?? ""), { provider: last.provider, reason: last.routeReason });
  await fakeLm.close();
  fakeLm = null;
  out = await askUi(s, "Parlami ancora del catalogo e dell'astrolabio");
  check("PRISM auto, LM Studio down → dialog with the cheapest priced cloud candidate (Gemini) and the reason", !!out.dialog && out.dialog.title === "Inviare la domanda a Google Gemini?" && out.dialog.facts.Modello === MODELS.gemini.chat && /LM Studio non è raggiungibile/.test(out.dialog.facts["Scelta del modello"]) && /più economico/.test(out.dialog.facts["Scelta del modello"]) && cloudCount() === n3,
    out.dialog?.facts);
  await s.screenshot("05-prism-dialog");
  await dialogButton(s, "Invia a Google Gemini");
  await waitAnswerAfter(s, out.before);
  ms = await s.must("list_messages", { conversationId: convs[0].id });
  last = ms.at(-1);
  check("PRISM cloud answer: Gemini, reason stored, cost from Gemini prices", last.provider === "gemini" && last.status === "complete" && /LM Studio non è raggiungibile/.test(last.routeReason) && last.cost?.currency === "USD" && fakeCloud.requests.slice(n3).every((r) => r.provider === "gemini"), { p: last.provider, cost: last.cost, hits: fakeCloud.requests.slice(n3).map((r) => r.provider) });
  // Inspector shows the PRISM decision.
  await s.click(await s.find(".chat-log .msg-assistant:last-of-type .msg-inspect"));
  const inspFacts = await s.waitFor(`document.querySelector('#chat-inspector .inspector-facts')?.textContent.replace(/\\s+/g,' ')`, "inspector");
  check("inspector shows provider/model and the PRISM reason", /Google Gemini/.test(inspFacts) && /LM Studio non è raggiungibile/.test(inspFacts), inspFacts.slice(0, 400));
  await s.click(await s.find('#chat-inspector button[aria-label="Chiudi dettagli"]'));
  // Local-only project in auto with LM Studio down → never cloud.
  n3 = cloudCount();
  const convP2 = await s.must("create_conversation", { projectId: P2.id });
  const pv2 = await s.invoke("prepare_cloud_send", { input: { conversationId: convP2.id, text: "Parlami del giacinto" } });
  const r2 = await s.sendRaw({ conversationId: convP2.id, text: "Parlami del giacinto" });
  check("local-only project in auto, LM Studio down → no preview, answer «Nessun modello disponibile: … «Solo locale» …», nothing to the cloud",
    pv2.ok && pv2.value === null && r2.ok && r2.value.status === "error" && /^Nessun modello disponibile: il progetto è «Solo locale»/.test(r2.value.error.message) && cloudCount() === n3, { pv: pv2, msg: r2.value?.error });
  // Restart the fake LM Studio for the rest.
  fakeLm = await startFakeLmStudio({ port: lmPort, recordFile: lmRecord });

  // ---- Cloud embeddings with per-project consent
  await s.must("set_llm_settings", { settings: settings(lmUrl, { chatModel: ref("openai", MODELS.openai.chat) }) });
  await goSettings(s);
  const embPick = await setSelectByLabel(s, ".models-settings", "Modello di embedding", `openai:${MODELS.openai.embedding}`);
  await sleep(3000);
  st = await s.must("get_llm_settings");
  const embReqs = () => fakeCloud.requests.filter((r) => r.path.endsWith("/embeddings") || r.path.includes(":batchEmbedContents"));
  let es1 = await s.must("get_embedding_status", { projectId: P1.id });
  let es2 = await s.must("get_embedding_status", { projectId: P2.id });
  check("cloud embedding model chosen in Impostazioni (group «Cloud»)", !String(embPick).startsWith("no-option") && embPick !== "missing-or-disabled" && st.embeddingModel?.provider === "openai" && st.embeddingModel.model === MODELS.openai.embedding, embPick);
  check("without consent: both projects needs_consent, NO embedding request", es1.state === "needs_consent" && es2.state === "needs_consent" && es1.provider === "openai" && embReqs().length === 0, { es1, es2, emb: embReqs().length });
  const est0 = await s.must("estimate_cloud_embedding", { projectId: P1.id });
  check("estimate_cloud_embedding: passages, chars, tokens ≈ chars/4, no price → null cost", est0.provider === "openai" && est0.model === MODELS.openai.embedding && est0.chunks === es1.total && est0.chars > 0 && est0.estTokens === Math.ceil(est0.chars / 4) && est0.estCost === null, est0);
  n3 = cloudCount();
  // A question now: lexical, no query embedding to the cloud.
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: "Che cosa misura l'astrolabio?" } });
  check("no consent: preview declares no query embedding; nothing sent", pv.queryEmbeddedBy === null && cloudCount() === n3, pv.queryEmbeddedBy);
  await s.must("discard_cloud_send", { token: pv.token });
  await s.must("set_price", { price: { provider: "openai", model: MODELS.openai.embedding, inputPerMTok: 0.02, outputPerMTok: 0, currency: "USD" } });
  await selectProject(s, P1.id);
  const idx = await s.waitFor(`document.querySelector('.cloud-indexing')?.textContent.replace(/\\s+/g,' ')`, "cloud indexing block");
  check("project detail «Indicizzazione cloud»: model + host, no consent yet", idx.includes(`OpenAI · ${MODELS.openai.embedding}`) && idx.includes("api.openai.com") && /Senza consenso la ricerca di questo progetto resta lessicale/.test(idx), idx);
  await s.click(await s.findByText("button", "Consenti indicizzazione cloud…"));
  const cdlg = await s.waitFor(`(() => { const d = document.querySelector('dialog[open]'); return d && /Indicizzare/.test(d.textContent) && !/Stima in corso/.test(d.textContent) ? d.textContent.replace(/\\s+/g,' ') : false; })()`, "consent dialog with estimate");
  check("consent dialog: provider, model, what is sent, estimate with passages/chars/tokens/cost", /Indicizzare «Cloud E2E» con OpenAI\?/.test(cdlg) && cdlg.includes(MODELS.openai.embedding) && new RegExp(`${est0.chunks} passagg`).test(cdlg) && /token/.test(cdlg) && /USD|\$/.test(cdlg), cdlg.slice(0, 600));
  check("opening the consent dialog sent nothing", cloudCount() === n3);
  await s.screenshot("06-embedding-consent");
  await s.click(await s.findByText("dialog[@open]//button", "Consenti e invia a OpenAI"));
  for (let i = 0; i < 80; i++) {
    es1 = await s.must("get_embedding_status", { projectId: P1.id });
    if (es1.state === "idle" && es1.embedded === es1.total) break;
    await sleep(250);
  }
  es2 = await s.must("get_embedding_status", { projectId: P2.id });
  const embAll = embReqs();
  const embInputs = embAll.flatMap((r) => r.body.input ?? []);
  check("after consent: P1 indexed via OpenAI embeddings (idle, X of X)", es1.state === "idle" && es1.embedded === es1.total && es1.total > 0 && embAll.length >= 1 && embAll.every((r) => r.provider === "openai" && r.auth.ok && r.body.model === MODELS.openai.embedding), { es1, n: embAll.length });
  check("indexing sent ONLY P1 passages (the local-only project's text never left)", embInputs.length === es1.total && embInputs.every((t) => !/giacinto/.test(t)) && es2.state === "needs_consent" && es2.embedded === 0, { inputs: embInputs.length, es2 });
  log = await s.must("list_cloud_requests", { limit: 200 });
  const idxLog = log.filter((x) => x.purpose === "index_embedding");
  check("log: index_embedding entries for P1 only, chars = sent, usage, cost from the embedding price", idxLog.length === embAll.length && idxLog.every((x) => x.projectId === P1.id && x.ok && x.usage?.inputTokens > 0 && x.cost?.currency === "USD") && idxLog.reduce((n, x) => n + x.charsSent, 0) === embInputs.reduce((n, t) => n + [...t].length, 0), idxLog);
  // Ask → query embedding (declared in the preview), then chat after confirmation.
  await goChat(s);
  n3 = cloudCount();
  out = await askUi(s, "Che cosa misura l'astrolabio di ottone?");
  prev = (await s.exec(`return window.__qa.previews;`)).filter(Boolean).at(-1);
  const qe = fakeCloud.requests.slice(n3);
  check("with consent: the query embedding is sent during the preview and declared (queryEmbeddedBy, «Già inviato»)", prev.queryEmbeddedBy?.provider === "openai" && prev.queryEmbeddedBy.model === MODELS.openai.embedding && /Per la ricerca semantica la domanda è stata inviata a OpenAI/.test(out.dialog.facts["Già inviato"] ?? "") && qe.length === 1 && qe[0].path === "/v1/embeddings" && qe[0].body.input.length === 1,
    { q: prev.queryEmbeddedBy, hits: qe.map((r) => r.path) });
  note("design: with embedding consent the question is embedded by the cloud provider BEFORE the chat confirmation dialog (declared there as «Già inviato»); «Annulla» therefore cancels only the chat request");
  await dialogButton(s, "Invia a OpenAI");
  await waitAnswerAfter(s, out.before);
  convs = await s.must("list_conversations", { projectId: P1.id });
  ms = await s.must("list_messages", { conversationId: convs[0].id });
  last = ms.at(-1);
  check("answer retrieval hybrid with the cloud embedding model", last.retrieval?.mode === "hybrid" && last.retrieval.embeddingProvider === "openai" && last.retrieval.embeddingModel === MODELS.openai.embedding, last.retrieval);
  // send_message without a token while embedding consent is active: the chat is refused, but does
  // retrieval (and its cloud query embedding) run first? Reported, not asserted either way.
  {
    const nq = cloudCount();
    const mcq = (await s.must("list_messages", { conversationId: convB.id })).length;
    const r = await s.sendRaw({ conversationId: convB.id, text: "Che cosa misura l'astrolabio di ottone? (senza conferma)" });
    const hitsQ = fakeCloud.requests.slice(nq);
    check("no token with embedding consent: consent_required, no chat request, nothing stored", !r.ok && r.err.code === "consent_required" && hitsQ.every((x) => !x.path.endsWith("/chat/completions")) && (await s.must("list_messages", { conversationId: convB.id })).length === mcq, { err: r.err, hits: hitsQ.map((x) => x.path) });
    if (hitsQ.length > 0) note(`a refused send_message (no token) still sent ${hitsQ.length} request(s) to the cloud: ${hitsQ.map((x) => `${x.provider} ${x.path}`).join(", ")} (query embedding during retrieval, before the consent check)`);
  }
  // Revoke → no further embedding requests (new document, new question).
  await selectProject(s, P1.id);
  await s.click(await s.findByText("button", "Revoca consenso"));
  await s.waitFor(`!document.querySelector('.cloud-indexing')?.textContent.includes('Consenso dato')`, "revoked");
  const nE = embReqs().length;
  await s.importText(P1.id, "nuovo.txt", "Un nuovo testo sul sestante e sull'astrolabio nautico.\n");
  await sleep(4000);
  es1 = await s.must("get_embedding_status", { projectId: P1.id });
  pv = await s.must("prepare_cloud_send", { input: { conversationId: convB.id, text: "Parlami del sestante e dell'astrolabio" } });
  check("after revocation: no embedding requests (new passages not sent), needs_consent, no query embedding", embReqs().length === nE && es1.state === "needs_consent" && pv.queryEmbeddedBy === null, { emb: embReqs().length - nE, es1: es1.state, q: pv.queryEmbeddedBy });
  await s.must("discard_cloud_send", { token: pv.token });
  // Consent again, then switch to local-only → consent revoked too.
  await s.must("set_cloud_embedding_consent", { projectId: P1.id, consent: true });
  await sleep(2500);
  const lo = await s.must("set_project_cloud_policy", { projectId: P1.id, policy: "local_only" });
  check("switching to «Solo locale» also revokes the embedding consent", lo.cloudPolicy === "local_only" && lo.cloudEmbeddingConsent === false, lo);
  const consentLocal = await s.invoke("set_cloud_embedding_consent", { projectId: P2.id, consent: true });
  const p2now = (await s.must("list_projects")).find((p) => p.id === P2.id);
  check("embedding consent on a local-only project is refused (conflict), flag stays false", !consentLocal.ok && consentLocal.err.code === "conflict" && p2now.cloudEmbeddingConsent === false, { r: consentLocal.ok ? consentLocal.value : consentLocal.err });
  const nE2 = embReqs().length;
  await sleep(3000);
  check("P2 with a consent flag but local-only: still no embedding request for its passages", embReqs().length === nE2 && embReqs().flatMap((r) => r.body.input ?? []).every((t) => !/giacinto/.test(t)));
  await s.must("set_cloud_embedding_consent", { projectId: P2.id, consent: false }).catch(() => {});
  await s.must("set_project_cloud_policy", { projectId: P1.id, policy: "cloud_allowed" });
  await s.must("set_cloud_embedding_consent", { projectId: P1.id, consent: true });
  await sleep(2500);

  // ---- Cloud request log vs recorder; never content or key
  log = await s.must("list_cloud_requests", { limit: 1000 });
  const logJson = JSON.stringify(log);
  check("every fake-provider request has exactly one log entry", log.length === fakeCloud.requests.length, `${log.length} log vs ${fakeCloud.requests.length} requests`);
  check("log entries: purpose/provider/chars/usage/cost/ok; never content (question, passages) nor key", log.every((x) => ["chat", "query_embedding", "index_embedding", "list_models"].includes(x.purpose) && PROVIDERS.includes(x.provider) && typeof x.charsSent === "number") &&
    !/astrolabio|zefiro|giacinto|sk-TEST/.test(logJson), [...new Set(log.map((x) => x.purpose))]);
  await goSettings(s);
  await s.click(await s.findByText("section[contains(@class,'activity-settings')]//button", "Aggiorna")).catch(() => {});
  const actRows = await s.waitFor(`document.querySelectorAll('.activity-table tbody tr').length`, "activity rows").catch(() => 0);
  const actHead = await s.exec(`return [...document.querySelectorAll('.activity-table th')].map(t => t.textContent.trim());`);
  check("«Attività cloud» table lists the requests (date, provider, model, purpose, chars, tokens, cost, outcome)", actRows > 0 && actHead.length >= 7, { actRows, actHead });

  // ---- Keys never in the DOM, IPC responses, DB files, stderr
  const ipc = await s.exec(`return window.__qa.ipc;`);
  check("no IPC response ever contained a key", ipc.every((x) => !Object.values(KEYS).some((k) => x.includes(k)) && !x.includes("sk-TEST-SENTINEL")), `${ipc.length} responses`);
  const htmlNow = await s.exec(`return document.documentElement.outerHTML;`);
  check("keys not in the DOM", !htmlNow.includes("sk-TEST-SENTINEL"));
  const files = fileTree(appDir);
  const dbFiles = files.filter((f) => /localis\.db(-wal|-shm)?$/.test(f));
  const hits = files.filter((f) => {
    const buf = readFileSync(f);
    return Object.values(KEYS).some((k) => buf.includes(Buffer.from(k))) || buf.includes(Buffer.from("sk-TEST-SENTINEL"));
  });
  check("no key in any file of the app data dir (main DB, WAL, SHM, originals…)", hits.length === 0 && dbFiles.length >= 1, { dbFiles: dbFiles.map((f) => f.slice(appDir.length)), hits });
  const errText = existsSync(stderrLog) ? readFileSync(stderrLog, "utf8") : "";
  check("no key in the app's stdout/stderr", !errText.includes("sk-TEST-SENTINEL"), `${errText.length} bytes of logs`);
  const otherHits = fileTree(dataRoot).filter((f) => !f.includes("/data/keyrings/") && !f.startsWith(join(dataRoot, "run")) && statSync(f).size < 50e6 && readFileSync(f).includes(Buffer.from("sk-TEST-SENTINEL")));
  check("no key anywhere in the test HOME/XDG tree except the (encrypted) keyring files", otherHits.length === 0, otherHits);

  // ---- Network: only loopback
  sampleNet();
  const remotes = [...new Set(netSamples)];
  check("app/webview TCP connections seen only to loopback (lsof samples)", remotes.length > 0 && remotes.every((r) => /^(127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\]):/.test(r)), remotes);
  check("every fake request came from loopback with a loopback Host header", fakeCloud.requests.every((r) => /^(::ffff:)?127\.0\.0\.1$/.test(r.remote) && /^127\.0\.0\.1:\d+$/.test(r.host)));
  const qa = await s.exec(`return { fetches: window.__qa.fetches, csp: window.__qa.csp, errors: window.__qa.errors };`);
  check("webview made no fetch/XHR, no CSP violation, no page error", qa.fetches.every((u) => /^(ipc:|http:\/\/ipc\.localhost)/.test(u)) && qa.csp.length === 0 && qa.errors.length === 0, qa);

  // ---- Restart persistence
  const snap = {
    settings: await s.must("get_llm_settings"),
    prices: await s.must("list_prices"),
    projects: await s.must("list_projects"),
    msgs: await s.must("list_messages", { conversationId: convA.id }),
    log: (await s.must("list_cloud_requests", { limit: 1000 })).length,
  };
  await killApp();
  await s.quit().catch(() => {});
  s = await openApp();
  const after = {
    settings: await s.must("get_llm_settings"),
    prices: await s.must("list_prices"),
    projects: await s.must("list_projects"),
    msgs: await s.must("list_messages", { conversationId: convA.id }),
    log: (await s.must("list_cloud_requests", { limit: 1000 })).length,
  };
  check("restart: settings (models, routing, candidates) persist", JSON.stringify(after.settings) === JSON.stringify(snap.settings), after.settings);
  check("restart: prices persist", JSON.stringify(after.prices) === JSON.stringify(snap.prices));
  check("restart: project policy and consent persist", JSON.stringify(after.projects.map((p) => [p.id, p.cloudPolicy, p.cloudEmbeddingConsent])) === JSON.stringify(snap.projects.map((p) => [p.id, p.cloudPolicy, p.cloudEmbeddingConsent])));
  check("restart: messages with provider/usage/cost/routeReason persist", JSON.stringify(after.msgs) === JSON.stringify(snap.msgs) && after.msgs.some((m) => m.provider === "openai" && m.cost));
  check("restart: cloud log persists", after.log >= snap.log, `${snap.log} → ${after.log}`);
  const provAfter = await s.must("list_providers");
  check("restart: keys still present (read from the keychain)", provAfter.every((p) => p.hasKey), provAfter.map((p) => `${p.id}:${p.hasKey}`));

  // ---- Remove a key via the UI → keychain entry gone
  await goSettings(s);
  await s.click(await s.findByText("section[contains(@class,'provider')][.//h3[normalize-space(.)='Qwen (Alibaba Cloud)']]//button", "Rimuovi chiave"));
  await s.waitFor(`document.querySelector('dialog[open]')?.textContent.includes('Rimuovere la chiave di Qwen')`, "remove dialog");
  await s.click(await s.findByText("dialog[@open]//button", "Rimuovi chiave"));
  await s.waitFor(`!!document.querySelector('#api-key-qwen')`, "qwen key form back");
  check("«Rimuovi chiave» → hasKey false and the Secret Service entry is gone", !(await s.must("list_providers")).find((p) => p.id === "qwen").hasKey && secretLookup("qwen") === null);
  const qwenModels = fakeCloud.of("qwen", "/models").length;
  const lmq = await s.must("list_provider_models", { provider: "qwen" });
  check("without a key «list_provider_models» sends nothing and explains", !lmq.reachable && /Nessuna chiave API salvata per Qwen/.test(lmq.message) && fakeCloud.of("qwen", "/models").length === qwenModels, lmq.message);

  // ---- keyring_unavailable branch (same app, no Secret Service reachable)
  writeFileSync(noKeyringFlag, "1");
  await killApp();
  await s.quit().catch(() => {});
  s = await openApp();
  const ks2 = await s.must("get_keyring_status");
  const sk2 = await s.invoke("set_api_key", { provider: "qwen", key: KEYS.qwen });
  const pv3 = await s.invoke("list_providers");
  check("no Secret Service → get_keyring_status unavailable with an Italian message", ks2.available === false && /portachiavi di sistema non è disponibile/.test(ks2.message ?? ""), ks2);
  check("no Secret Service → set_api_key keyring_unavailable, no plaintext fallback (hasKey false everywhere)", !sk2.ok && sk2.err.code === "keyring_unavailable" && !JSON.stringify(sk2).includes("sk-TEST") && pv3.ok && pv3.value.every((p) => !p.hasKey), { err: sk2.err });
  await goSettings(s);
  const off = await s.waitFor(`document.querySelector('.keyring-off')?.textContent.replace(/\\s+/g,' ')`, "keyring notice");
  const fieldsOff = await s.exec(`return [...document.querySelectorAll('.provider input[type=password]')].map(i => i.disabled);`);
  check("UI: keyring notice + key fields disabled", /non esiste un'alternativa in chiaro/.test(off) && fieldsOff.length > 0 && fieldsOff.every(Boolean), { off: off.slice(0, 200), fieldsOff });
  const n4 = cloudCount();
  const convC = await s.must("create_conversation", { projectId: P1.id });
  const pv4 = await s.invoke("prepare_cloud_send", { input: { conversationId: convC.id, text: "Parlami dell'astrolabio" } });
  check("no keychain: a cloud question cannot be prepared (keyring_unavailable/llm_unavailable), nothing sent", !pv4.ok && ["keyring_unavailable", "llm_unavailable"].includes(pv4.err.code) && cloudCount() === n4, pv4.err);
  const all2 = existsSync(stderrLog) ? readFileSync(stderrLog, "utf8") : "";
  check("still no key in logs", !all2.includes("sk-TEST-SENTINEL"));
  await s.screenshot("07-keyring-off");
  rmSync(noKeyringFlag);
  await s.quit().catch(() => {});
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  let m = String(err?.stack ?? err);
  for (const k of Object.values(KEYS)) m = m.split(k).join("[SENTINEL]");
  console.error(`ERROR: ${m}`);
} finally {
  await cleanup();
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed${failed ? ", scenario aborted" : ""}`);
if (notes.length) console.log(`notes:\n- ${notes.join("\n- ")}`);
process.exit(failed || passed !== results.length ? 1 : 0);
