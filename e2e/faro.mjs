// Native end-to-end test of v0.5 FARO (lectures): drives the real Localis desktop app
// (WebKitGTK webview + real SQLite + real originals archive + real chunked upload + real
// `localis-media` protocol + real whisper.cpp transcription with the tiny model) through
// tauri-driver / WebKitWebDriver using the W3C WebDriver protocol. Plain Node >= 22, no deps.
//
// ROADMAP 0.5 proof: import a lecture, transcribe it locally, link an interval to a slide
// (PDF page + region drawn with the mouse) or a photo — plus timestamps/seek, search, chat
// citations, cancel, restart persistence, deletions, Whisper model downloads (fake server).
//
// Prerequisites (Linux): same as e2e/native.mjs, plus
//   - espeak-ng and ffmpeg (only to generate the synthetic lecture fixtures at test time)
//   - a verified ggml-tiny.bin (sha256 be07e048…1b21): LOCALIS_WHISPER_TEST_MODEL=<path>.
//     It is COPIED into the test app's models directory (installed by copy), and also served
//     by the loopback fake Hugging Face server for the download flow. Never downloaded here.
//   - GStreamer decoders for playback checks in WebKitGTK (mpg123 for MP3; an AAC/H.264
//     decoder such as gstreamer1.0-libav for MP4). Without them playback checks fail honestly.
//   - lsof (network check), pgrep.
//
// Run:
//   LOCALIS_WHISPER_TEST_MODEL=/path/ggml-tiny.bin node e2e/faro.mjs
//
// Environment (optional): LOCALIS_BIN, TAURI_DRIVER, E2E_PORT (default 4484), E2E_ARTIFACTS
// (screenshots, driver log, fake server logs), E2E_KEEP=1.
//
// Isolation: everything (fixtures, app data, HOME/XDG dirs, TMPDIR) lives in a fresh temporary
// directory removed at the end (unless E2E_KEEP=1). The app is started through a launcher that
// sets LOCALIS_TEST_HF_BASE_URL (debug builds only) to the loopback fake HF server, and a dead
// proxy for every scheme. Fake servers listen on loopback only and log every request.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
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
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { CHAT_MODEL, startFakeLmStudio } from "./fake-lmstudio.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.LOCALIS_BIN ?? join(REPO, "target/debug/localis");
const PORT = Number(process.env.E2E_PORT ?? 4484);
const ARTIFACTS = process.env.E2E_ARTIFACTS ? resolve(process.env.E2E_ARTIFACTS) : null;
const TINY = process.env.LOCALIS_WHISPER_TEST_MODEL ?? "";
const TINY_SHA = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
const IDENTIFIER = "app.localis.desktop";
const ENTER = "\uE007";
const ESC = "\uE00C";
const TAB = "\uE004";
const lm = (model) => ({ provider: "lmstudio", model });

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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${String(info).slice(0, 700)})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sha256File = (p) =>
  new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`section «${name}» completed without errors`, false, e.stack ?? e);
  }
}

// ---------- synthetic fixtures ----------
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
/** Three "slides" (landscape pages) with distinct text; no words of the lecture's key terms. */
function slidesPdf() {
  const texts = [
    "BT /F1 36 Tf 60 500 Td (Slide 1: programma del corso) Tj 0 -50 Td (Parola unica: quarzite) Tj ET",
    "BT /F1 36 Tf 60 500 Td (Slide 2: schema dello stroma) Tj 0 -50 Td (Parola unica: tilacoide) Tj ET 0.9 0.2 0.2 rg 400 80 300 200 re f",
    "BT /F1 36 Tf 60 500 Td (Slide 3: esercizi finali) Tj 0 -50 Td (Parola unica: basalto) Tj ET",
  ];
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>"];
  texts.forEach((t, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(stream("", t));
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  return buildPdf(objs);
}
function png(w = 400, h = 300) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 240 - (y % 40 < 2 ? 120 : 0); raw[o + 1] = 235 - (x % 60 < 2 ? 120 : 0); raw[o + 2] = 200;
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
const LECTURE =
  "Buongiorno a tutti e benvenuti alla lezione di biologia. Oggi parliamo della fotosintesi clorofilliana. " +
  "La fotosintesi trasforma la luce del sole in energia chimica. Le piante usano l'anidride carbonica e l'acqua " +
  "per produrre glucosio e ossigeno. Questo processo avviene nei cloroplasti, che contengono la clorofilla. " +
  "Nella prima fase, chiamata fase luminosa, la luce viene catturata. Nella seconda fase, il ciclo di Calvin, " +
  "si forma il glucosio. Guardate ora la seconda slide, dove trovate lo schema del cloroplasto. Ricordate: senza " +
  "luce non c'è fotosintesi. Alla fine della lezione faremo alcuni esercizi sul ciclo di Calvin. Grazie per " +
  "l'attenzione e arrivederci alla prossima settimana.";
const EXPECTED_WORDS = ["fotosintesi", "luce", "glucosio", "ossigeno", "piante", "clorofilla", "lezione", "calvin", "acqua", "energia", "sole", "fase"];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
}
function makeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const wav = join(dir, "speech.wav");
  const lecture = join(dir, "lecture.wav");
  run("espeak-ng", ["-v", "it", "-s", "130", "-w", wav, LECTURE]);
  run("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-t", "2", "-i", "anullsrc=r=22050:cl=mono", "-i", wav,
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1", "-ar", "22050", "-ac", "1", lecture]);
  const mp4 = join(dir, "lezione-biologia.mp4");
  // A constant 2.5 Mbit/s video track makes the file ~19 MB: three upload chunks of 8 MiB.
  run("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25", "-i", lecture, "-shortest",
    "-map_metadata", "-1", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2500k", "-minrate", "2500k", "-maxrate", "2500k",
    "-bufsize", "2500k", "-x264-params", "nal-hrd=cbr", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", mp4]);
  const mp3 = join(dir, "lezione-audio.mp3");
  run("ffmpeg", ["-loglevel", "error", "-y", "-i", lecture, "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "48k", mp3]);
  const files = { "lezione-biologia.mp4": readFileSync(mp4), "lezione-audio.mp3": readFileSync(mp3) };
  files["slide.pdf"] = slidesPdf();
  files["foto-appunti.png"] = png();
  files["muto.mp4"] = readFileSync(join(REPO, "crates/localis-core/tests/fixtures/muto.mp4"));
  const out = {};
  for (const [name, buf] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, buf);
    out[name] = { path: p, sha: sha256(buf), size: buf.length };
  }
  return out;
}

// ---------- fake Hugging Face server (loopback TEST FIXTURE, never the real host) ----------
const HF_PATH = "/ggerganov/whisper.cpp/resolve/main/";
const HF_SIZES = { "ggml-base.bin": 147951465, "ggml-small.bin": 487601967, "ggml-large-v3-turbo-q5_0.bin": 574041195 };
async function startFakeHf(logFile) {
  const fake = { requests: [], url: null, evilHits: [] };
  const log = (entry) => {
    fake.requests.push(entry);
    if (logFile) writeFileSync(logFile, JSON.stringify(entry) + "\n", { flag: "a" });
  };
  const server = createServer((req, res) => {
    log({ method: req.method, url: req.url, host: req.headers.host, at: Date.now() });
    const file = req.url.startsWith(HF_PATH) ? req.url.slice(HF_PATH.length) : req.url.startsWith("/cdn/") ? req.url.slice(5) : null;
    if (req.url.startsWith(HF_PATH) && file === "ggml-base.bin") {
      // Allowed same-origin redirect (like the CDN hop), then wrong bytes with the right size.
      res.writeHead(302, { location: `/cdn/${file}` });
      return res.end();
    }
    if (req.url.startsWith(HF_PATH) && file === "ggml-large-v3-turbo-q5_0.bin") {
      res.writeHead(302, { location: `${fake.evilUrl}/steal/${file}` });
      return res.end();
    }
    if (file === "ggml-tiny.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(statSync(TINY).size) });
      return createReadStream(TINY).pipe(res);
    }
    if (file === "ggml-base.bin" || file === "ggml-small.bin") {
      const total = HF_SIZES[file];
      const slow = file === "ggml-small.bin";
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(total) });
      const block = Buffer.alloc(1024 * 1024, 0);
      let sent = 0;
      let closed = false;
      res.on("close", () => (closed = true));
      const pump = () => {
        while (!closed && sent < total) {
          const n = Math.min(block.length, total - sent);
          sent += n;
          const ok = res.write(n === block.length ? block : block.subarray(0, n));
          if (slow) return setTimeout(pump, 120);
          if (!ok) return res.once("drain", pump);
        }
        if (!closed) res.end();
      };
      return pump();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  // A second loopback address stands for a foreign host: it must never be contacted.
  const evil = createServer((req, res) => {
    fake.evilHits.push(req.url);
    res.writeHead(200);
    res.end("evil");
  });
  await new Promise((r) => evil.listen(0, "127.0.0.2", r));
  fake.evilUrl = `http://127.0.0.2:${evil.address().port}`;
  fake.close = () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => evil.close(r))]).then(() => undefined);
  server.closeAllConnections?.();
  fake.server = server;
  return fake;
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
let APP_LAUNCHER = BIN;

class Session {
  static async start() {
    const value = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: APP_LAUNCHER } } },
    });
    const s = new Session();
    s.id = value.sessionId;
    await wd("POST", s.p("/timeouts"), { script: 120000 }).catch(() => {});
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
    return ref(await wd("POST", this.p("/element"), { using: "xpath", value: `//${tag}[normalize-space(.)=${JSON.stringify(text)}]` }));
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
  /** Mouse drag from (x1,y1) to (x2,y2), offsets from the element's centre (W3C). */
  async drag(el, x1, y1, x2, y2) {
    const origin = { [ELEMENT]: el };
    await wd("POST", this.p("/actions"), {
      actions: [{
        type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin, x: x1, y: y1 },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 150, origin, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
          { type: "pointerMove", duration: 150, origin, x: x2, y: y2 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
    await wd("DELETE", this.p("/actions"));
  }
  async screenshot(name) {
    if (!ARTIFACTS) return;
    try {
      const b64 = await wd("GET", this.p("/screenshot"));
      writeFileSync(join(ARTIFACTS, `faro-${name}.png`), Buffer.from(b64, "base64"));
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
    throw new Error(`timeout waiting for: ${desc} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
  }
  text(css) {
    return this.exec(`const e = document.querySelector(arguments[0]); return e ? e.textContent.trim() : null;`, [css]);
  }
  invoke(cmd, args) {
    return this.execAsync(
      `const done = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(
         (v) => done({ ok: true, value: v instanceof ArrayBuffer ? { bytes: v.byteLength } : v }),
         (e) => done({ ok: false, err: e }));`,
      [cmd, args ?? {}],
    );
  }
  /** Raw-body command (upload_chunk): `n` bytes of value `fill`, with headers. */
  invokeRaw(cmd, n, headers, fill = 7) {
    return this.execAsync(
      `const done = arguments[arguments.length - 1];
       const body = new Uint8Array(arguments[1]).fill(arguments[3]);
       window.__TAURI_INTERNALS__.invoke(arguments[0], body, { headers: arguments[2] }).then(
         (v) => done({ ok: true, value: v ?? null }), (e) => done({ ok: false, err: e }));`,
      [cmd, n, headers, fill],
    );
  }
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
let fakeHf;
let fakeLm;
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
  const log = ARTIFACTS ? createWriteStream(join(ARTIFACTS, "faro-driver.log")) : null;
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
async function cleanup() {
  await stopDriver();
  for (const pid of appPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  if (fakeHf) await fakeHf.close().catch(() => {});
  if (fakeLm) await fakeLm.close().catch(() => {});
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
    window.__qa = { csp: [], errors: [], importPct: [], fetches: [] };
    document.addEventListener('securitypolicyviolation', (e) => window.__qa.csp.push(e.violatedDirective + ' ' + e.blockedURI));
    window.addEventListener('error', (e) => window.__qa.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__qa.errors.push('rejection: ' + String(e.reason && (e.reason.message || JSON.stringify(e.reason)))));
    const origFetch = window.fetch;
    window.fetch = function (u, o) { window.__qa.fetches.push(String(u && u.url || u)); return origFetch.apply(this, arguments); };
    new MutationObserver(() => {
      const p = document.querySelector('.import-progress');
      if (p) { const t = p.querySelector('.import-bytes')?.textContent.trim(); const a = window.__qa.importPct; if (t && a[a.length - 1] !== t) a.push(t); }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  return true;`;
async function openApp() {
  const s = await Session.start();
  await s.waitFor(`document.querySelector('.onboarding, .empty, .project-list, .banner-error')`, "projects view loaded");
  await s.exec(INSTRUMENT);
  return s;
}
const nav = (label) => `button[contains(@class,'nav-item')]`;
async function goLibrary(s) {
  await s.click(await s.findByText(nav(), "Libreria"));
  await s.waitFor(`document.querySelector('.view-library .library')`, "library view");
}
async function goChat(s) {
  await s.click(await s.findByText(nav(), "Chat"));
  await s.waitFor(`document.querySelector('#chat-composer-input')`, "chat view");
}
async function goSettings(s) {
  await s.click(await s.findByText(nav(), "Impostazioni"));
  await s.waitFor(`document.querySelector('#transcription-settings-title')`, "settings view");
}
async function openDoc(s, title) {
  await s.click(await s.find(`.doc-open[title=${JSON.stringify(title)}]`));
  await s.waitFor(`document.getElementById('viewer-title')?.textContent.trim() === ${JSON.stringify(title)}`, `viewer for ${title}`);
}
const MEDIA = `document.querySelector('.media-element')`;
async function mediaState(s) {
  return s.exec(`const m = ${MEDIA}; if (!m) return null; return { tag: m.tagName, src: m.currentSrc || m.src, t: m.currentTime, d: m.duration,
    rs: m.readyState, ns: m.networkState, paused: m.paused, err: m.error ? m.error.code + ' ' + m.error.message : null,
    buffered: m.buffered.length ? [m.buffered.start(0), m.buffered.end(m.buffered.length - 1)] : null };`);
}
async function setInput(s, css, value) {
  await s.exec(`const i = document.querySelector(arguments[0]);
    const proto = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : i.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, arguments[1]);
    i.dispatchEvent(new Event(i.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    if (i.tagName === 'SELECT') i.dispatchEvent(new Event('input', { bubbles: true }));`, [css, value]);
}
async function clearAndType(s, css, value) {
  await setInput(s, css, "");
  await s.type(await s.find(css), value);
}
function db(path, sql, ...params) {
  // node:sqlite (Node 22) read-only, only for verification.
  return import("node:sqlite").then(({ DatabaseSync }) => {
    const d = new DatabaseSync(path, { readOnly: true });
    try {
      return d.prepare(sql).all(...params);
    } finally {
      d.close();
    }
  });
}
function listDir(p) {
  try {
    return readdirSync(p);
  } catch {
    return null;
  }
}
async function waitJob(s, versionId, pred, desc, timeout = 600000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    const jobs = (await s.invoke("list_jobs", { projectId: globalThis.projectId })).value ?? [];
    const mine = jobs.filter((j) => j.versionId === versionId && j.kind === "transcribe").sort((a, b) => b.id - a.id);
    last = mine[0];
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`timeout waiting for job: ${desc} (last ${JSON.stringify(last)})`);
}

// ---------- scenario ----------
async function main() {
  if (!existsSync(BIN)) throw new Error(`app binary not found: ${BIN}`);
  if (!TINY || !existsSync(TINY)) throw new Error("LOCALIS_WHISPER_TEST_MODEL must point to a verified ggml-tiny.bin");
  if (ARTIFACTS) mkdirSync(ARTIFACTS, { recursive: true });
  dataRoot = mkdtempSync(join(tmpdir(), "localis-e2e-faro-"));
  const F = makeFixtures(join(dataRoot, "fixtures"));
  console.log(`      fixtures: ${Object.entries(F).map(([n, f]) => `${n} ${f.size} B`).join(", ")}`);
  check("lecture MP4 fixture is larger than 2 upload chunks (> 16 MiB)", F["lezione-biologia.mp4"].size > 16 * 1024 * 1024, F["lezione-biologia.mp4"].size);
  const appDir = join(dataRoot, "data", IDENTIFIER);
  const dbPath = join(appDir, "localis.db");
  const originals = join(appDir, "originals");
  const uploadsDir = join(originals, ".uploads");
  const modelsDir = join(appDir, "models", "whisper");
  const blobPath = (sha) => join(originals, sha.slice(0, 2), sha);

  // Tiny installed by copy (verified first).
  check("test model is the verified tiny (sha256)", (await sha256File(TINY)) === TINY_SHA);
  mkdirSync(modelsDir, { recursive: true });
  copyFileSync(TINY, join(modelsDir, "ggml-tiny.bin"));

  fakeHf = await startFakeHf(ARTIFACTS ? join(ARTIFACTS, "faro-fake-hf.jsonl") : join(dataRoot, "fake-hf.jsonl"));
  fakeLm = await startFakeLmStudio({ recordFile: join(dataRoot, "fake-lm.jsonl") });
  APP_LAUNCHER = join(dataRoot, "launch.sh");
  writeFileSync(APP_LAUNCHER, `#!/bin/sh\nexport LOCALIS_TEST_HF_BASE_URL=${fakeHf.url}\nexport HTTP_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9 NO_PROXY= no_proxy= GIO_USE_PROXY_RESOLVER=dummy\n${process.env.FARO_GST_DEBUG ? `export GST_DEBUG=${process.env.FARO_GST_DEBUG}\n` : ""}exec ${JSON.stringify(BIN)} "$@" 2>>${JSON.stringify(join(ARTIFACTS ?? dataRoot, "faro-app-stderr.log"))}\n`, { mode: 0o755 });
  await startDriver();
  const net = [];
  const sampleNet = () => net.push(...appConnections());

  let s = await openApp();
  await s.click(await s.findByText("button", "Crea il primo progetto"));
  await s.waitFor(`document.activeElement?.id === 'project-name'`, "create dialog");
  await s.type(await s.find("#project-name"), "FARO E2E");
  await s.click(await s.findByText("dialog[@open]//button", "Crea progetto"));
  await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.project-option')`, "project created");
  const projectId = (await s.invoke("list_projects")).value[0].id;
  globalThis.projectId = projectId;
  await s.click(await s.findByText("button", "Apri libreria"));
  await s.waitFor(`document.querySelector('.view-library .library')`, "library loaded");

  let byTitle = {};
  const refreshDocs = async () => {
    const list = (await s.invoke("list_documents", { projectId })).value;
    byTitle = Object.fromEntries(list.map((d) => [d.title, d]));
    return byTitle;
  };
  const MP4 = "lezione-biologia.mp4";
  const MP3 = "lezione-audio.mp3";

  // ================= 1. Import (chunked) =================
  await section("import", async () => {
    await s.type(await s.find('[data-testid="import-input"]'), F[MP4].path);
    await s.waitFor(`document.querySelector('.import-item') && !document.querySelector('.import-progress')`, "mp4 imported", 120000);
    const seen = await s.exec(`return window.__qa.importPct;`);
    console.log(`      import progress texts seen: ${JSON.stringify(seen)}`);
    check("chunked import shows per-file progress (% · bytes) with several steps", seen.length >= 2 && seen.some((t) => /%/.test(t)), seen.join(" | "));
    const outcome = await s.exec(`return [...document.querySelectorAll('.import-item')].map(li => li.dataset.kind + ':' + li.querySelector('.import-name').textContent.trim());`);
    check("MP4 lecture imported via <input type=file>", outcome.length === 1 && outcome[0] === `imported:${MP4}`, outcome.join(","));
    await s.type(await s.find('[data-testid="import-input"]'), [F[MP3].path, F["slide.pdf"].path, F["foto-appunti.png"].path, F["muto.mp4"].path].join("\n"));
    await s.waitFor(`document.querySelectorAll('.doc-row').length === 5 && !document.querySelector('.import-summary .spinner')`, "5 rows", 60000);
    const out2 = await s.exec(`return [...document.querySelectorAll('.import-item')].map(li => li.dataset.kind + ':' + li.querySelector('.import-name').textContent.trim());`);
    check("MP3, PDF slides, PNG photo and muto.mp4 imported", out2.length === 4 && out2.every((o) => o.startsWith("imported:")), out2.join(", "));
    await refreshDocs();
    for (const n of Object.keys(F)) {
      const v = byTitle[n]?.current;
      const p = v && blobPath(v.sha256);
      check(`blob ${n}: in originals/, byte-identical, sha256 + size recorded`, v && v.sha256 === F[n].sha && v.sizeBytes === F[n].size && existsSync(p) && sha256(readFileSync(p)) === F[n].sha, v ? `${v.kind} ${v.mediaType}` : "missing");
    }
    const mp4v = byTitle[MP4].current;
    const mp3v = byTitle[MP3].current;
    check("MP4: kind video, video/mp4, duration ≈ 58 s, 640x360", mp4v.kind === "video" && mp4v.mediaType === "video/mp4" && Math.abs(mp4v.durationMs - 58000) < 1500 && mp4v.imageWidth === 640 && mp4v.imageHeight === 360, JSON.stringify({ d: mp4v.durationMs, w: mp4v.imageWidth, h: mp4v.imageHeight }));
    check("MP3: kind audio, audio/mpeg, duration ≈ 58 s", mp3v.kind === "audio" && mp3v.mediaType === "audio/mpeg" && Math.abs(mp3v.durationMs - 58000) < 1500, String(mp3v.durationMs));
    check("muto.mp4: importable as video (no audio track)", byTitle["muto.mp4"]?.current.kind === "video", JSON.stringify(byTitle["muto.mp4"]?.current));
    check("slide.pdf has 3 pages; PNG 400x300", byTitle["slide.pdf"].current.pageCount === 3 && byTitle["foto-appunti.png"].current.imageWidth === 400);
    const rows = await s.rows();
    console.log(`      rows: ${JSON.stringify(rows)}`);
    check("list shows duration (00:58) and «Da trascrivere» for the recordings", /00:5[78]/.test(rows[MP4].meta) && rows[MP4].label === "Da trascrivere" && rows[MP3].label === "Da trascrivere", `${rows[MP4].meta} / ${rows[MP4].label}`);
    check("originals/.uploads is empty after the imports", (listDir(uploadsDir) ?? []).length === 0, JSON.stringify(listDir(uploadsDir)));
    await s.screenshot("01-imported");
  });

  // ================= 2. Upload robustness (invoke) =================
  await section("upload robustness", async () => {
    const begin = (fileName, sizeBytes, extra = {}) => s.invoke("begin_upload", { input: { projectId, fileName, sizeBytes, ...extra } });
    const chunk = (uploadId, offset, n, fill) => s.invokeRaw("upload_chunk", n, { "x-upload-id": uploadId, "x-offset": String(offset) }, fill);
    let r = await begin("prova.mp4", 100);
    check("begin_upload ok (chunkBytes 8 MiB)", r.ok && r.value.chunkBytes === 8 * 1024 * 1024, JSON.stringify(r));
    const id = r.value.uploadId;
    check("temp file created in originals/.uploads", (listDir(uploadsDir) ?? []).some((f) => f.startsWith(id)), JSON.stringify(listDir(uploadsDir)));
    r = await chunk(id, 50, 10);
    check("out-of-order offset → validation", !r.ok && r.err.code === "validation", JSON.stringify(r.err));
    r = await chunk(id, 0, 60);
    check("first chunk at 0 accepted", r.ok, JSON.stringify(r));
    r = await chunk(id, 0, 10);
    check("repeated offset 0 → validation", !r.ok && r.err.code === "validation", JSON.stringify(r.err));
    r = await chunk(id, 60, 50);
    check("overflow past declared size → validation", !r.ok && r.err.code === "validation" && /dichiarata/.test(r.err.message), JSON.stringify(r.err));
    r = await s.invoke("finish_upload", { uploadId: id });
    check("finish with missing bytes → validation (incomplete)", !r.ok && r.err.code === "validation", JSON.stringify(r.err));
    r = await s.invokeRaw("upload_chunk", 10, { "x-upload-id": id, "x-offset": "-5" });
    check("negative x-offset rejected", !r.ok, JSON.stringify(r.err));
    r = await s.invokeRaw("upload_chunk", 10, { "x-upload-id": id });
    check("missing x-offset rejected", !r.ok, JSON.stringify(r.err));
    r = await s.invokeRaw("upload_chunk", 10, { "x-upload-id": "../../etc/passwd", "x-offset": "60" });
    check("malicious upload id rejected", !r.ok, JSON.stringify(r.err));
    r = await s.invoke("cancel_upload", { uploadId: id });
    check("cancel_upload ok", r.ok);
    check("cancel removes the temp file", !(listDir(uploadsDir) ?? []).some((f) => f.startsWith(id)), JSON.stringify(listDir(uploadsDir)));
    r = await chunk(id, 60, 40);
    check("chunk after cancel → not_found", !r.ok && r.err.code === "not_found", JSON.stringify(r.err));
    r = await begin("enorme.mp4", 4 * 1024 ** 3 + 1);
    check("declared > 4 GiB media → too_large", !r.ok && r.err.code === "too_large", JSON.stringify(r.err));
    r = await begin("grande.pdf", 200 * 1024 ** 2 + 1);
    check("declared > 200 MiB PDF → too_large", !r.ok && r.err.code === "too_large", JSON.stringify(r.err));
    r = await begin("programma.exe", 10);
    check("unsupported extension → unsupported", !r.ok && r.err.code === "unsupported", JSON.stringify(r.err));
    r = await begin("../../evil.mp3", 10);
    check("file name with path → validation (or sanitized)", !r.ok || !r.value.uploadId.includes("/"), JSON.stringify(r));
    if (r.ok) await s.invoke("cancel_upload", { uploadId: r.value.uploadId });
    r = await s.invoke("begin_upload", { input: { projectId: "00000000-0000-4000-8000-000000000000", fileName: "x.mp3", sizeBytes: 10 } });
    check("unknown project → not_found", !r.ok && r.err.code === "not_found", JSON.stringify(r.err));
    r = await begin("vuoto.mp3", 0);
    check("zero-size upload rejected (or finishes as validation)", !r.ok || (await s.invoke("finish_upload", { uploadId: r.value.uploadId })).ok === false, JSON.stringify(r));
    // Chunk larger than 8 MiB.
    r = await begin("grosso.mp4", 9 * 1024 * 1024);
    const big = r.value.uploadId;
    r = await chunk(big, 0, 8 * 1024 * 1024 + 1);
    check("chunk > 8 MiB → validation", !r.ok && r.err.code === "validation", JSON.stringify(r.err));
    await s.invoke("cancel_upload", { uploadId: big });
    // A complete upload of bytes that are not audio → unsupported, temp removed.
    r = await begin("falso.mp3", 1000);
    const fakeId = r.value.uploadId;
    await chunk(fakeId, 0, 1000, 0x41);
    r = await s.invoke("finish_upload", { uploadId: fakeId });
    check("finish of a non-audio .mp3 → unsupported", !r.ok && r.err.code === "unsupported", JSON.stringify(r.err));
    check("…and its temp file is removed", (listDir(uploadsDir) ?? []).length === 0, JSON.stringify(listDir(uploadsDir)));
    // Duplicate of an imported file, uploaded in chunks.
    const bytes = readFileSync(F[MP3].path);
    r = await begin("copia.mp3", bytes.length);
    const dupId = r.value.uploadId;
    const okChunk = await s.execAsync(
      `const done = arguments[arguments.length - 1];
       const bin = atob(arguments[1]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
       window.__TAURI_INTERNALS__.invoke('upload_chunk', u, { headers: { 'x-upload-id': arguments[0], 'x-offset': '0' } }).then(() => done(true), (e) => done(e));`,
      [dupId, bytes.toString("base64")],
    );
    r = await s.invoke("finish_upload", { uploadId: dupId });
    check("chunked upload of an existing file → duplicate (same document)", okChunk === true && r.ok && r.value.status === "duplicate" && r.value.document.title === MP3, JSON.stringify(r).slice(0, 200));
    check("originals/.uploads empty after the robustness checks", (listDir(uploadsDir) ?? []).length === 0, JSON.stringify(listDir(uploadsDir)));
  });

  // ================= 3. Playback through localis-media =================
  await section("playback", async () => {
    await openDoc(s, MP4);
    await s.waitFor(`${MEDIA} && ${MEDIA}.readyState >= 1`, "video metadata", 20000);
    let m = await mediaState(s);
    console.log(`      video: ${JSON.stringify(m)}`);
    check("video element uses the localis-media scheme with the version id", m.tag === "VIDEO" && m.src.startsWith("localis-media:") && m.src.endsWith(byTitle[MP4].current.id), m.src);
    check("video metadata loaded: duration ≈ 58 s", Math.abs(m.d - 58) < 1.5, String(m.d));
    // Play muted for ~600 ms.
    await s.exec(`const v = ${MEDIA}; v.muted = true; v.play();`);
    await sleep(1200);
    m = await mediaState(s);
    check("video actually plays (currentTime advances)", m.t > 0.2 && !m.err, JSON.stringify(m));
    // Seek far into a 19 MB file: needs HTTP Range (responses are capped at 4 MiB).
    await s.exec(`const v = ${MEDIA}; v.currentTime = 50; v.play();`);
    await sleep(1500);
    m = await mediaState(s);
    check("seek to 0:50 and keep playing (Range requests past the first block)", m.t > 50.2 && !m.err && m.rs >= 2, JSON.stringify(m));
    await s.exec(`${MEDIA}.pause();`);
  });
  await section("playback audio", async () => {
    await openDoc(s, MP3);
    await s.waitFor(`${MEDIA} && ${MEDIA}.readyState >= 1`, "audio metadata", 20000);
    await s.exec(`const v = ${MEDIA}; v.muted = true; v.currentTime = 30; v.play();`);
    await sleep(1200);
    m = await mediaState(s);
    console.log(`      audio: ${JSON.stringify(m)}`);
    check("MP3 plays from 0:30 in an <audio> element", m.tag === "AUDIO" && m.t > 30.2 && !m.err && Math.abs(m.d - 58) < 2, JSON.stringify(m));
    await s.exec(`${MEDIA}.pause();`);
    // Invalid ids / non-media versions: the protocol answers an error, the element reports it.
  });
  await section("media protocol probes", async () => {
    const probe = async (id) =>
      s.execAsync(
        `const done = arguments[arguments.length - 1];
         const a = document.createElement('audio'); a.preload = 'auto';
         const t = setTimeout(() => done('timeout'), 8000);
         a.onloadedmetadata = () => { clearTimeout(t); done('loaded'); };
         a.onerror = () => { clearTimeout(t); done('error ' + (a.error && a.error.code)); };
         a.src = window.__TAURI_INTERNALS__.convertFileSrc(arguments[0], 'localis-media');`,
        [id],
      );
    const pdfId = byTitle["slide.pdf"].current.id;
    const results2 = { valid: await probe(byTitle[MP3].current.id), pdf: await probe(pdfId), unknown: await probe("00000000-0000-4000-8000-000000000000"), traversal: await probe("../localis.db") };
    console.log(`      media probes: ${JSON.stringify(results2)}`);
    check("localis-media: valid audio version loads", results2.valid === "loaded");
    check("localis-media: PDF version id, unknown id and ../localis.db are refused (media error)", [results2.pdf, results2.unknown, results2.traversal].every((x) => x.startsWith("error")), JSON.stringify(results2));
    const csp = await s.exec(`return window.__qa.csp;`);
    check("no CSP violations during playback", csp.length === 0, JSON.stringify(csp));
  });

  if (process.env.FARO_STOP_AFTER === "playback") return;
  // ================= 4. Transcription =================
  let segments = [];
  await section("transcription", async () => {
    await openDoc(s, MP4);
    await s.click(await s.findByText("button", "Trascrivi"));
    await s.waitFor(`document.querySelector('dialog[open] input[type=radio][value=tiny]')`, "transcribe dialog");
    const dlg = await s.exec(`const d = document.querySelector('dialog[open]'); return { text: d.textContent, tinyChecked: d.querySelector('input[value=tiny]').checked,
      tinyDisabled: d.querySelector('input[value=tiny]').disabled, baseDisabled: d.querySelector('input[value=base]').disabled,
      downloadBtns: [...d.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t.startsWith('Scarica')) };`);
    check("transcribe dialog: tiny installed and preselected; others not installed with «Scarica (size)»", dlg.tinyChecked && !dlg.tinyDisabled && dlg.baseDisabled && dlg.downloadBtns.length === 3, JSON.stringify(dlg.downloadBtns));
    check("transcribe dialog says it runs on this computer and may contain errors", /su questo computer/.test(dlg.text) && /errori/.test(dlg.text));
    await setInput(s, "dialog[open] select", "it");
    await s.click(await s.findByText("dialog[@open]//button", "Avvia la trascrizione"));
    await s.waitFor(`!document.querySelector('dialog[open]')`, "dialog closed");
    const labels = new Set();
    const progress = new Set();
    const end = Date.now() + 600000;
    let job;
    const t0 = Date.now();
    while (Date.now() < end) {
      const l = await s.exec(`return [...document.querySelectorAll('.doc-row')].find(li => li.querySelector('.doc-title').textContent.trim() === arguments[0])?.querySelector('.status-text')?.textContent.trim();`, [MP4]);
      if (l) labels.add(l);
      const v = await s.exec(`const p = document.querySelector('.transcribe-progress progress'); return p ? p.value : null;`);
      if (v != null) progress.add(v);
      job = (await s.invoke("list_jobs", { projectId })).value.filter((j) => j.kind === "transcribe" && j.versionId === byTitle[MP4].current.id).sort((a, b) => b.id - a.id)[0];
      if (job && (job.state === "done" || job.state === "failed")) break;
      await sleep(250);
    }
    const secs = (Date.now() - t0) / 1000;
    console.log(`      transcription took ${secs.toFixed(1)} s; labels seen: ${[...labels].join(" | ")}; progress values: ${[...progress].join(",")}`);
    check("transcription job completes (done)", job?.state === "done" && job.progress === 100, JSON.stringify(job));
    check("progress «Trascrizione in corso N %» observed in the list, with growing values", [...labels].some((l) => /^Trascrizione in corso \d+ %$/.test(l)) && progress.size >= 2, [...labels].join(" | "));
    await s.waitFor(`document.querySelectorAll('.transcript .segment').length > 0`, "segments shown", 20000);
    const ui = await s.exec(`return { label: document.querySelector('.transcript-label')?.textContent.trim(),
      segs: [...document.querySelectorAll('.transcript .segment')].map(li => ({ t: li.querySelector('.segment-time').textContent.trim(), aria: li.querySelector('.segment-time').getAttribute('aria-label'), text: li.querySelector('.segment-text').textContent.trim() })),
      row: [...document.querySelectorAll('.doc-row')].find(li => li.querySelector('.doc-title').textContent.trim() === arguments[0])?.querySelector('.status-text')?.textContent.trim() };`, [MP4]);
    console.log(`      transcript: ${ui.segs.map((x) => `[${x.t}] ${x.text}`).join(" ")}`);
    check("label «Trascrizione automatica (Whisper tiny) — può contenere errori»", ui.label === "Trascrizione automatica (Whisper tiny) — può contenere errori", ui.label);
    check("row label «Trascritta (Whisper tiny)»", ui.row === "Trascritta (Whisper tiny)", ui.row);
    check("segments carry mm:ss timestamps with spoken aria-labels", ui.segs.length >= 3 && ui.segs.every((x) => /^\d\d:\d\d$/.test(x.t) && /^Vai a \d\d:\d\d \(/.test(x.aria)), JSON.stringify(ui.segs.slice(0, 2)));
    const all = ui.segs.map((x) => x.text).join(" ").toLowerCase();
    const found = EXPECTED_WORDS.filter((w) => all.includes(w));
    check("transcript plausibly matches the lecture (≥ 4 expected words)", found.length >= 4, found.join(","));
    const tr = (await s.invoke("get_transcript", { versionId: byTitle[MP4].current.id })).value;
    segments = tr;
    check("get_transcript: 1-based consecutive indices, monotonic startMs ≤ endMs ≤ duration", tr.length === ui.segs.length && tr.every((x, i) => x.index === i + 1 && x.startMs <= x.endMs && x.endMs <= 60000 && (i === 0 || x.startMs >= tr[i - 1].startMs)), JSON.stringify(tr.slice(0, 2)));
    check("first segment starts after the 2 s of leading silence (± tolerance)", tr[0].startMs >= 1000, String(tr[0].startMs));
    await refreshDocs();
    const v = byTitle[MP4].current;
    check("version: textStatus extracted, transcription {tiny, it, segmentCount}", v.textStatus === "extracted" && v.transcription?.model === "tiny" && v.transcription.language === "it" && v.transcription.segmentCount === tr.length, JSON.stringify(v.transcription));
    const text = (await s.invoke("get_text", { versionId: v.id })).value;
    check("get_text of the media = segments with startMs/endMs", text.length === tr.length && text[0].unit === 1 && text[0].startMs === tr[0].startMs, JSON.stringify(text[0]));
    const chunks = await db(dbPath, "SELECT unit, ordinal, length(text) AS n FROM chunks WHERE version_id = ?", v.id);
    check("chunks: passages of consecutive segments ≤ 1200 chars, unit = first segment", chunks.length >= 1 && chunks.every((c) => c.n <= 1200 && c.unit >= 1), JSON.stringify(chunks));
    // Click the 3rd timestamp → currentTime.
    const k = Math.min(2, tr.length - 1);
    const btns = await wd("POST", s.p("/elements"), { using: "css selector", value: ".transcript .segment-time" });
    await s.click(ref(btns[k]));
    await sleep(700);
    const m = await mediaState(s);
    check(`clicking timestamp ${ui.segs[k].t} sets video currentTime to startMs (${tr[k].startMs} ms)`, m.t >= tr[k].startMs / 1000 - 0.05 && m.t < tr[k].startMs / 1000 + 1.5, `t=${m.t}`);
    const cur = await s.exec(`return document.querySelector('.transcript .segment.is-current')?.dataset.index;`);
    check("the segment playing is highlighted (aria-current=time)", Number(cur) === k + 1 || Number(cur) === k + 2, String(cur));
    await s.exec(`${MEDIA}.pause();`);
    await s.screenshot("02-transcribed");
  });

  // ================= 5. Second transcription: busy checks + cancel =================
  await section("cancel transcription", async () => {
    const vId = byTitle[MP4].current.id;
    const before = (await s.invoke("get_transcript", { versionId: vId })).value;
    let r = await s.invoke("start_transcription", { versionId: vId, model: "tiny", language: "auto" });
    check("second transcription queued", r.ok && (r.value.state === "queued" || r.value.state === "running"), JSON.stringify(r));
    const jobId = r.value.id;
    r = await s.invoke("start_transcription", { versionId: vId, model: "tiny", language: "it" });
    check("third start while one is queued/running → conflict", !r.ok && r.err.code === "conflict", JSON.stringify(r.err));
    await waitJob(s, vId, (j) => j.state === "running" && j.progress >= 12, "running ≥ 12 %", 300000);
    r = await s.invoke("delete_whisper_model", { id: "tiny" });
    check("deleting the model in use → conflict, file kept", !r.ok && r.err.code === "conflict" && existsSync(join(modelsDir, "ggml-tiny.bin")), JSON.stringify(r.err));
    await s.waitFor(`[...document.querySelectorAll('.transcribe-bar button')].some(b => b.textContent.trim() === 'Annulla')`, "Annulla in the viewer", 10000);
    const viewerWhile = await s.exec(`return { segs: document.querySelectorAll('.transcript .segment').length, bar: document.querySelector('.transcribe-bar').textContent };`);
    check("while re-transcribing, the current transcript stays visible with a note", viewerWhile.segs === before.length && /resta visibile/.test(viewerWhile.bar), JSON.stringify(viewerWhile));
    const t0 = Date.now();
    await s.click(await s.findByText("div[contains(@class,'transcribe-bar')]//button", "Annulla"));
    const job = await waitJob(s, vId, (j) => j.id === jobId && j.state === "failed", "cancelled", 30000);
    console.log(`      cancel took effect in ${Date.now() - t0} ms`);
    check("cancelled job: state failed with «Trascrizione annullata.»", job.error === "Trascrizione annullata.", JSON.stringify(job));
    await sleep(1500);
    const after = (await s.invoke("get_transcript", { versionId: vId })).value;
    check("previous transcript kept after cancel (same segments)", JSON.stringify(after) === JSON.stringify(before), `${before.length} → ${after.length}`);
    await refreshDocs();
    check("version stays extracted with the previous transcription info", byTitle[MP4].current.textStatus === "extracted" && byTitle[MP4].current.transcription?.segmentCount === before.length);
    const rows = await s.rows();
    check("row label back to «Trascritta (Whisper tiny)»", rows[MP4].label === "Trascritta (Whisper tiny)", rows[MP4].label);
    const runningAny = (await s.invoke("list_jobs", { projectId })).value.some((j) => j.kind === "transcribe" && j.state === "running");
    check("no transcription left running (whisper aborted)", !runningAny);
    const bar = await s.text(".transcribe-bar");
    console.log(`      viewer bar after cancel: ${bar}`);
  });

  // ================= 6. Muto (no audio) =================
  await section("no audio track", async () => {
    const vId = byTitle["muto.mp4"].current.id;
    const r = await s.invoke("start_transcription", { versionId: vId, model: "tiny", language: "it" });
    check("muto.mp4: transcription can be started", r.ok, JSON.stringify(r));
    const job = await waitJob(s, vId, (j) => j.state === "failed" || j.state === "done", "muto finished", 60000);
    check("muto.mp4: fails with the honest codec message", job.state === "failed" && /trascrizione non disponibile per questa codifica/.test(job.error ?? ""), JSON.stringify(job));
    await sleep(2500);
    const rows = await s.rows();
    check("muto.mp4 row: «Trascrizione non riuscita» with Riprova", rows["muto.mp4"].label === "Trascrizione non riuscita" && rows["muto.mp4"].retry, JSON.stringify(rows["muto.mp4"]));
    await openDoc(s, "muto.mp4");
    const err = await s.text(".transcribe-error");
    check("viewer shows the codec error", /codifica/.test(err ?? ""), err);
  });

  // ================= 7. Search =================
  await section("search", async () => {
    const words = segments.map((x) => x.text).join(" ").toLowerCase();
    const word = ["fotosintesi", "glucosio", "clorofilla", "ossigeno", "piante", "energia", "luce"].find((w) => words.includes(w));
    check("a searchable keyword exists in the transcript", !!word, word);
    const seg = segments.find((x) => x.text.toLowerCase().includes(word));
    const input = await s.find("input[type=search]");
    await setInput(s, "input[type=search]", "");
    await s.type(input, word);
    await s.keys(ENTER);
    await s.waitFor(`(() => { const t = document.getElementById('search-results-title'); return t && t.closest('section').getAttribute('aria-busy') !== 'true'; })()`, "search results");
    const hits = await s.exec(`return [...document.querySelectorAll('.hit')].map(h => ({ title: h.querySelector('.hit-title').textContent.trim(), unit: h.querySelector('.hit-unit').textContent.trim() }));`);
    console.log(`      hits for «${word}»: ${JSON.stringify(hits)}`);
    const hit = hits.find((h) => h.title === MP4);
    check("Libreria search finds the transcript segment, unit shown as timestamp", !!hit && /^\d\d:\d\d$/.test(hit.unit), JSON.stringify(hits));
    const api = (await s.invoke("search", { projectId, query: word })).value;
    const apiHit = api.find((h) => h.title === MP4);
    check("search API: unitKind segment with startMs", apiHit?.unitKind === "segment" && typeof apiHit.startMs === "number", JSON.stringify(apiHit));
    await s.click(await s.findByText("button[contains(@class,'hit')]//span[contains(@class,'hit-title')]", MP4));
    await s.waitFor(`document.getElementById('viewer-title')?.textContent.trim() === ${JSON.stringify(MP4)} && ${MEDIA} && ${MEDIA}.readyState >= 1`, "player from hit");
    await sleep(800);
    const m = await mediaState(s);
    check("search hit opens the player at startMs", Math.abs(m.t - apiHit.startMs / 1000) < 0.6, `t=${m.t} startMs=${apiHit.startMs}`);
    const target = await s.exec(`return document.querySelector('.transcript .segment.is-target')?.dataset.index;`);
    check("…and marks the hit segment", Number(target) === apiHit.unit, `${target} vs ${apiHit.unit}`);
    check("hit segment really contains the word", seg && apiHit.unit >= 1);
    await setInput(s, "input[type=search]", "");
    await sleep(300);
  });

  // ================= 8. Links =================
  const pdfShaBefore = sha256(readFileSync(blobPath(F["slide.pdf"].sha)));
  const pngShaBefore = sha256(readFileSync(blobPath(F["foto-appunti.png"].sha)));
  let pdfLink;
  await section("links", async () => {
    await openDoc(s, MP4);
    await s.waitFor(`document.querySelectorAll('.transcript .segment').length > 0`, "segments");
    await s.click(await s.findByText("button", "Seleziona segmenti da collegare"));
    const checks = await wd("POST", s.p("/elements"), { using: "css selector", value: ".transcript .segment-check" });
    await s.click(ref(checks[1]));
    await s.click(ref(checks[2]));
    await s.click(await s.findByText("button", "Collega la selezione"));
    await s.waitFor(`document.querySelector('dialog[open].link-dialog')`, "link dialog");
    const startEnd = await s.exec(`const i = [...document.querySelectorAll('dialog[open] .time-field input')]; return i.map(x => x.value);`);
    const expStart = segments[1].startMs, expEnd = segments[2].endMs;
    const fmt = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    check("link dialog prefilled from the two selected segments", startEnd[0] === fmt(expStart) && startEnd[1] === fmt(expEnd), `${startEnd} vs ${fmt(expStart)}–${fmt(expEnd)}`);
    // Validation in the UI: end <= start.
    await clearAndType(s, "dialog[open] .time-field:nth-child(2) input", startEnd[0]);
    await s.click(await s.findByText("dialog[@open]//button", "Crea collegamento"));
    await s.waitFor(`document.querySelector('dialog[open] .field-error')`, "inline error");
    let errs = await s.exec(`return [...document.querySelectorAll('dialog[open] .field-error')].map(e => e.textContent.trim());`);
    check("UI validation: end ≤ start → «La fine deve venire dopo l'inizio.» (and missing target)", errs.includes("La fine deve venire dopo l'inizio.") && errs.some((e) => /Scegli un PDF/.test(e)), errs.join(" | "));
    check("first invalid field focused, aria-invalid set", await s.exec(`const a = document.activeElement; return a && a.getAttribute('aria-invalid') === 'true';`));
    await clearAndType(s, "dialog[open] .time-field:nth-child(2) input", startEnd[1]);
    const pdfDocId = byTitle["slide.pdf"].id;
    await setInput(s, "dialog[open] select", pdfDocId);
    await s.waitFor(`document.querySelector('dialog[open] input[type=number][min="1"]')`, "page field");
    await clearAndType(s, "dialog[open] .page-choice input", "5");
    // «Una regione»
    await s.click(await s.findByText("dialog[@open]//label[contains(@class,'segmented-option')]/span", "Una regione"));
    await s.waitFor(`document.querySelector('dialog[open] [data-testid=region-draw]')`, "region picker", 20000);
    await s.click(await s.findByText("dialog[@open]//button", "Crea collegamento"));
    await s.waitFor(`[...document.querySelectorAll('dialog[open] .field-error')].some(e => /pagina da 1 a 3/.test(e.textContent))`, "page error");
    errs = await s.exec(`return [...document.querySelectorAll('dialog[open] .field-error')].map(e => e.textContent.trim());`);
    check("UI validation: page 5 of 3 → «Scegli una pagina da 1 a 3.»; empty region → region error", errs.includes("Scegli una pagina da 1 a 3.") && errs.some((e) => /regione/.test(e)), errs.join(" | "));
    await clearAndType(s, "dialog[open] .page-choice input", "2");
    await s.waitFor(`(() => { const c = document.querySelector('dialog[open] .region-picker canvas'); return c && c.width > 0 && /pagina 2$/.test(c.getAttribute('aria-label')); })()`, "page 2 rendered", 20000);
    const surf = await s.find("dialog[open] [data-testid=region-draw]");
    const box = await s.exec(`const r = document.querySelector('dialog[open] [data-testid=region-draw]').getBoundingClientRect(); return { w: r.width, h: r.height };`);
    // Drag from 20 %/30 % to 70 %/80 % of the surface (offsets from its centre).
    await s.drag(surf, Math.round(-0.3 * box.w), Math.round(-0.2 * box.h), Math.round(0.2 * box.w), Math.round(0.3 * box.h));
    await sleep(300);
    const fields = await s.exec(`return ['x','y','w','h'].map(k => document.querySelector('dialog[open] [id$="-region-' + k + '"]').value);`);
    console.log(`      region drawn: ${JSON.stringify(fields)} on ${JSON.stringify(box)}`);
    const [fx, fy, fw, fh] = fields.map(Number);
    check("region drawn by mouse drag fills the numeric fields (~20/30/50/50 %)", Math.abs(fx - 20) < 3 && Math.abs(fy - 30) < 3 && Math.abs(fw - 50) < 3 && Math.abs(fh - 50) < 3, fields.join(","));
    check("drawn region box visible on the page", await s.exec(`return !!document.querySelector('dialog[open] .region-box');`));
    await setInput(s, "dialog[open] textarea", "Schema del cloroplasto");
    await s.screenshot("03-link-dialog");
    await s.click(await s.findByText("dialog[@open]//button", "Crea collegamento"));
    await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.link-row')`, "link created");
    let links = (await s.invoke("list_media_links", { mediaVersionId: byTitle[MP4].current.id })).value;
    pdfLink = links[0];
    check("link stored: PDF page 2, region ≈ (0.2,0.3,0.5,0.5), interval of the selection, note", links.length === 1 && pdfLink.targetPage === 2 && Math.abs(pdfLink.region.x - 0.2) < 0.03 && Math.abs(pdfLink.region.w - 0.5) < 0.03 && pdfLink.startMs === expStart && pdfLink.endMs === expEnd && pdfLink.note === "Schema del cloroplasto" && pdfLink.targetTitle === "slide.pdf" && pdfLink.mediaTitle === MP4 && pdfLink.available, JSON.stringify(pdfLink));
    const rowText = await s.text(".link-row");
    check("link row: interval → «slide.pdf · p. 2 · regione» + note; timeline interval drawn", /slide\.pdf · p\. 2 · regione/.test(rowText) && /Schema del cloroplasto/.test(rowText) && (await s.exec(`return document.querySelectorAll('.timeline-interval').length;`)) === 1, rowText);

    // Second link: manual mm:ss to the photo, whole image, via keyboard-ish path.
    await s.click(await s.findByText("button", "Nuovo collegamento"));
    await s.waitFor(`document.querySelector('dialog[open].link-dialog')`, "link dialog 2");
    await clearAndType(s, "dialog[open] .time-field:nth-child(1) input", "00:30");
    await clearAndType(s, "dialog[open] .time-field:nth-child(2) input", "00:40");
    await setInput(s, "dialog[open] select", byTitle["foto-appunti.png"].id);
    await s.waitFor(`[...document.querySelectorAll('dialog[open] .segmented-option span')].some(x => x.textContent.trim() === 'Immagine intera')`, "whole image option");
    const whole = await s.exec(`const r = [...document.querySelectorAll('dialog[open] .segmented-option')].find(l => l.textContent.trim() === 'Immagine intera'); return r.querySelector('input').checked;`);
    check("photo target: «Immagine intera» preselected, no page field", whole && !(await s.exec(`return !!document.querySelector('dialog[open] .page-choice');`)));
    await s.click(await s.findByText("dialog[@open]//button", "Crea collegamento"));
    await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelectorAll('.link-row').length === 2`, "2 links");
    links = (await s.invoke("list_media_links", { mediaVersionId: byTitle[MP4].current.id })).value;
    const photoLink = links.find((l) => l.targetTitle === "foto-appunti.png");
    check("photo link: 30000–40000 ms, page null, region null", photoLink && photoLink.startMs === 30000 && photoLink.endMs === 40000 && photoLink.targetPage === null && photoLink.region === null, JSON.stringify(photoLink));

    // Third link by keyboard only: numeric region fields on PDF page 3.
    await s.click(await s.findByText("button", "Nuovo collegamento"));
    await s.waitFor(`document.querySelector('dialog[open].link-dialog')`, "link dialog 3");
    await s.exec(`document.querySelector('dialog[open] .time-field input').focus();`);
    await s.keys(..."00:45".split(""));
    await s.keys(TAB, TAB); // «Imposta…» button, then «Fine»
    await s.keys(..."00:50".split(""));
    const focusedEnd = await s.exec(`return document.activeElement.value;`);
    await setInput(s, "dialog[open] select", byTitle["slide.pdf"].id);
    await s.waitFor(`document.querySelector('dialog[open] .page-choice input')`, "page input 3");
    await clearAndType(s, "dialog[open] .page-choice input", "3");
    const regionRadio = await s.exec(`return [...document.querySelectorAll('dialog[open] .segmented-option')].find(l => l.textContent.trim() === 'Una regione').querySelector('input');`);
    await s.exec(`arguments[0].focus();`, [regionRadio]);
    await s.keys(" ");
    await s.waitFor(`document.querySelector('dialog[open] [id$="-region-x"]')`, "region fields");
    for (const [k, v] of [["x", "10"], ["y", "10"], ["w", "95"], ["h", "20"]]) await clearAndType(s, `dialog[open] [id$="-region-${k}"]`, v);
    await s.exec(`document.querySelector('dialog[open] [id$="-region-h"]').focus();`);
    await s.keys(ENTER);
    await s.waitFor(`[...document.querySelectorAll('dialog[open] .field-error')].some(e => /regione/.test(e.textContent))`, "region bound error");
    check("UI validation: x + w > 100 % → region error (keyboard path, Enter submits)", true);
    await clearAndType(s, `dialog[open] [id$="-region-w"]`, "40");
    await s.exec(`document.querySelector('dialog[open] [id$="-region-h"]').focus();`);
    await s.keys(ENTER);
    await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelectorAll('.link-row').length === 3`, "3 links");
    links = (await s.invoke("list_media_links", { mediaVersionId: byTitle[MP4].current.id })).value;
    const kb = links.find((l) => l.targetPage === 3);
    check("keyboard-only link (typed times, numeric region) saved", focusedEnd === "00:50" && kb && kb.startMs === 45000 && kb.endMs === 50000 && Math.abs(kb.region.x - 0.1) < 1e-9 && Math.abs(kb.region.w - 0.4) < 1e-9, `${focusedEnd} ${JSON.stringify(kb?.region)}`);
    check("focus returns to the new link's row after saving", await s.exec(`return !!document.activeElement?.closest('.link-row');`));

    // Edit the photo link (note + end), then delete it.
    await s.click(await s.find(`button[aria-label^="Modifica il collegamento"][aria-label*="foto-appunti.png"]`));
    await s.waitFor(`document.querySelector('dialog[open].link-dialog')`, "edit dialog");
    check("edit dialog prefilled (00:30–00:40)", JSON.stringify(await s.exec(`return [...document.querySelectorAll('dialog[open] .time-field input')].map(x => x.value);`)) === JSON.stringify(["00:30", "00:40"]));
    await clearAndType(s, "dialog[open] .time-field:nth-child(2) input", "00:44");
    await setInput(s, "dialog[open] textarea", "Appunti a mano");
    await s.click(await s.findByText("dialog[@open]//button", "Salva"));
    await s.waitFor(`!document.querySelector('dialog[open]')`, "edit saved");
    links = (await s.invoke("list_media_links", { mediaVersionId: byTitle[MP4].current.id })).value;
    const edited = links.find((l) => l.id === photoLink.id);
    check("edited link: end 44000, note updated, updatedAt ≥ createdAt", edited.endMs === 44000 && edited.note === "Appunti a mano" && edited.updatedAt >= edited.createdAt, JSON.stringify(edited));
    await s.click(await s.find(`button[aria-label^="Elimina il collegamento"][aria-label*="foto-appunti.png"]`));
    await s.waitFor(`document.querySelector('dialog[open]')?.textContent.includes('Eliminare il collegamento?')`, "delete confirm");
    const confirmText = await s.text("dialog[open]");
    check("delete confirmation says recording and document are not touched", /non vengono toccati/.test(confirmText), confirmText);
    await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
    await s.waitFor(`!document.querySelector('dialog[open]') && document.querySelectorAll('.link-row').length === 2`, "photo link deleted");
    check("photo link deleted", !(await s.invoke("list_media_links", { mediaVersionId: byTitle[MP4].current.id })).value.some((l) => l.id === photoLink.id));
    // Recreate a photo link (whole image) for the backlink check on images.
    const rr = await s.invoke("create_media_link", { input: { mediaVersionId: byTitle[MP4].current.id, startMs: 5000, endMs: 9000, targetVersionId: byTitle["foto-appunti.png"].current.id, targetPage: null, region: null, note: null } });
    check("create_media_link (photo, whole image) via invoke", rr.ok, JSON.stringify(rr.err));

    // Open the PDF link → target page 2 with overlay.
    await s.click(await s.find(`button.link-target[aria-label*="p. 2"]`));
    await s.waitFor(`document.getElementById('viewer-title')?.textContent.trim() === 'slide.pdf' && document.querySelector('.region-overlay')`, "pdf with overlay", 20000);
    await sleep(800);
    const ov = await s.exec(`const o = document.querySelector('.region-overlay'); return { style: o.getAttribute('style'), label: o.getAttribute('aria-label'),
      page: document.querySelector('.page-field input')?.value, origin: document.querySelector('.link-origin h3')?.textContent.trim(),
      listen: [...document.querySelectorAll('.link-origin button')].map(b => b.textContent.trim()),
      backlinks: [...document.querySelectorAll('.backlink')].map(b => b.textContent.trim()) };`);
    console.log(`      overlay: ${JSON.stringify(ov)}`);
    check("open link → slide.pdf at page 2 with the region overlay at the stored position", ov.page === "2" && /left: 2\d(\.\d+)?%/.test(ov.style) && /top: 3\d(\.\d+)?%|top: 29\.\d+%/.test(ov.style) && /Regione collegata/.test(ov.label), JSON.stringify(ov));
    check("link origin banner «Collegato a lezione-biologia.mp4 · mm:ss–mm:ss · regione evidenziata»", /^Collegato a lezione-biologia\.mp4 · \d\d:\d\d–\d\d:\d\d · regione evidenziata$/.test(ov.origin), ov.origin);
    check("backlinks in the PDF viewer list both links to this PDF", ov.backlinks.length === 2 && ov.backlinks.every((b) => b.startsWith("Collegato a lezione-biologia.mp4 · ")), JSON.stringify(ov.backlinks));
    await s.screenshot("04-pdf-overlay");
    // Backlink → player at the right time.
    await s.click(await s.find(".backlink"));
    await s.waitFor(`document.getElementById('viewer-title')?.textContent.trim() === ${JSON.stringify(MP4)} && ${MEDIA} && ${MEDIA}.readyState >= 1`, "player via backlink", 20000);
    await sleep(800);
    let m = await mediaState(s);
    const blTarget = [pdfLink, kb].map((l) => l.startMs / 1000);
    check("backlink opens the player at the link start", blTarget.some((t) => Math.abs(m.t - t) < 0.6), `t=${m.t} expected one of ${blTarget}`);
    // Image backlink.
    await openDoc(s, "foto-appunti.png");
    await s.waitFor(`document.querySelector('.backlink')`, "image backlink", 10000);
    const ib = await s.text(".backlink");
    check("photo viewer shows backlink «Collegato a … · 00:05–00:09»", /Collegato a lezione-biologia\.mp4 · 00:05–00:09/.test(ib), ib);
    await s.click(await s.find(".backlink"));
    await s.waitFor(`document.getElementById('viewer-title')?.textContent.trim() === ${JSON.stringify(MP4)} && ${MEDIA} && ${MEDIA}.readyState >= 1`, "player via image backlink");
    await sleep(800);
    m = await mediaState(s);
    check("image backlink opens the player at 0:05", Math.abs(m.t - 5) < 0.6, `t=${m.t}`);
    // Backend validation edge cases.
    const base = { mediaVersionId: byTitle[MP4].current.id, startMs: 1000, endMs: 2000, targetVersionId: byTitle["slide.pdf"].current.id, targetPage: 1, region: null, note: null };
    const bad = [
      ["end == start", { endMs: 1000 }, "endMs"],
      ["negative start", { startMs: -1 }, "startMs"],
      ["end past duration", { endMs: 120000 }, "endMs"],
      ["page 0", { targetPage: 0 }, "targetPage"],
      ["page 4 of 3", { targetPage: 4 }, "targetPage"],
      ["PDF without page", { targetPage: null }, "targetPage"],
      ["image with a page", { targetVersionId: byTitle["foto-appunti.png"].current.id, targetPage: 1 }, "targetPage"],
      ["region w = 0", { region: { x: 0.1, y: 0.1, w: 0, h: 0.2 } }, "region"],
      ["region outside", { region: { x: 0.8, y: 0.1, w: 0.3, h: 0.2 } }, "region"],
      ["region negative", { region: { x: -0.1, y: 0.1, w: 0.3, h: 0.2 } }, "region"],
      ["note > 2000", { note: "x".repeat(2001) }, "note"],
      ["target is audio", { targetVersionId: byTitle[MP3].current.id, targetPage: null }, "targetVersionId"],
      ["media is a PDF", { mediaVersionId: byTitle["slide.pdf"].current.id }, "mediaVersionId"],
    ];
    for (const [name, patch, field] of bad) {
      const r = await s.invoke("create_media_link", { input: { ...base, ...patch } });
      check(`create_media_link ${name} → validation (field ${field})`, !r.ok && r.err.code === "validation" && r.err.field === field && !!r.err.message, JSON.stringify(r.err ?? r.value).slice(0, 200));
    }
    let r = await s.invoke("create_media_link", { input: { ...base, region: { x: "NaN", y: 0, w: 1, h: 1 } } });
    check("create_media_link with a non-number region → error, nothing stored", !r.ok, JSON.stringify(r.err));
    r = await s.invoke("create_media_link", { input: { ...base, targetVersionId: "00000000-0000-4000-8000-000000000000" } });
    check("create_media_link unknown target → not_found/validation", !r.ok && ["not_found", "validation"].includes(r.err.code), JSON.stringify(r.err));
    r = await s.invoke("update_media_link", { id: "00000000-0000-4000-8000-000000000000", input: base });
    check("update_media_link unknown id → not_found", !r.ok && r.err.code === "not_found", JSON.stringify(r.err));
    r = await s.invoke("delete_media_link", { id: "00000000-0000-4000-8000-000000000000" });
    check("delete_media_link unknown id → not_found", !r.ok && r.err.code === "not_found", JSON.stringify(r.err));
    check("PDF and PNG originals unchanged by regions/links (sha256)", sha256(readFileSync(blobPath(F["slide.pdf"].sha))) === pdfShaBefore && sha256(readFileSync(blobPath(F["foto-appunti.png"].sha))) === pngShaBefore && pdfShaBefore === F["slide.pdf"].sha);
    const files = spawnSync("find", [appDir, "-type", "f", "-newer", F["slide.pdf"].path, "-not", "-path", "*/localis.db*", "-not", "-path", "*WebKit*", "-not", "-path", "*/storage/*", "-not", "-path", "*/localstorage/*", "-not", "-path", "*hsts*"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    check("no derived files (crops/thumbnails) written next to the originals", files.every((f) => /originals\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(f) || /models\/whisper\/ggml-tiny\.bin$/.test(f)), files.map((f) => f.replace(appDir, "$APP")).join(" "));
  });

  // ================= 9. Chat citation =================
  await section("chat citation", async () => {
    await s.invoke("set_llm_settings", { settings: { baseUrl: fakeLm.url, chatModel: lm(CHAT_MODEL), embeddingModel: null, routing: "manual", autoModels: [] } });
    await goChat(s);
    const visible = await s.exec(`return !!document.querySelector('.conversations');`);
    if (!visible) await s.click(await s.find('button[aria-label="Mostra conversazioni"]'));
    await s.click(await s.findByText("button", "Nuova conversazione"));
    await s.waitFor(`document.querySelectorAll('.chat-log .msg').length === 0`, "empty conversation");
    const words = segments.map((x) => x.text).join(" ").toLowerCase();
    const word = ["fotosintesi", "glucosio", "clorofilla", "ossigeno", "piante", "energia"].find((w) => words.includes(w)) ?? "luce";
    await s.type(await s.find("#chat-composer-input"), `Che cosa dice la lezione sulla ${word}?`);
    await s.keys(ENTER);
    await s.waitFor(`document.querySelectorAll('.chat-log .msg-assistant').length === 1 && !document.querySelector('.chat-log [aria-busy="true"]') && document.querySelector('.chat-log .msg-assistant button.cite')`, "answer with citation", 60000);
    const cite = await s.exec(`return document.querySelector('.chat-log .msg-assistant button.cite').getAttribute('aria-label');`);
    const conv = (await s.invoke("list_conversations", { projectId })).value[0];
    const msgs = (await s.invoke("list_messages", { conversationId: conv.id })).value;
    const src = msgs[msgs.length - 1].sources.find((x) => x.n === 1);
    console.log(`      cite: ${cite}; source: ${JSON.stringify(src)}`);
    check("citation [1] is the lecture segment with hh:mm:ss timestamp", src?.title === MP4 && src.unitKind === "segment" && typeof src.startMs === "number" && /^Fonte 1: «lezione-biologia\.mp4», 00:\d\d:\d\d$/.test(cite), cite);
    const prompt = fakeLm.lastChat()?.body.messages.map((x) => x.content).join("\n") ?? "";
    check("prompt locator names the recording and the timestamp", /lezione-biologia\.mp4/.test(prompt) && /00:\d\d:\d\d|\d\d:\d\d/.test(prompt), (prompt.match(/.*lezione-biologia.*/) ?? [""])[0]);
    await s.click(await s.find(".chat-log .msg-assistant button.cite"));
    await s.waitFor(`document.getElementById('viewer-title')?.textContent.trim() === ${JSON.stringify(MP4)} && ${MEDIA} && ${MEDIA}.readyState >= 1`, "player from citation", 20000);
    await sleep(900);
    const m = await mediaState(s);
    check("citation opens the Libreria player at startMs", Math.abs(m.t - src.startMs / 1000) < 0.6, `t=${m.t} startMs=${src.startMs}`);
    const cp = await s.exec(`const c = document.querySelector('.cited-passage'); return c ? c.querySelector('h3').textContent.trim() : null;`);
    check("cited passage banner shows the clock timestamp", /00:\d\d:\d\d/.test(cp ?? ""), cp);
    check("cited segment highlighted", !!(await s.exec(`return document.querySelector('.transcript .segment.is-target');`)));
    sampleNet();
  });

  // ================= 10. UI: player keys, layout =================
  await section("player keyboard and layout", async () => {
    await s.exec(`const v = ${MEDIA}; v.pause(); v.muted = true; v.currentTime = 20;`);
    await sleep(500);
    await s.exec(`document.querySelector('.media-player').focus();`);
    await s.keys("\uE014"); // ArrowRight
    await sleep(500);
    let m = await mediaState(s);
    check("ArrowRight on the player region: +5 s", Math.abs(m.t - 25) < 0.6, String(m.t));
    await s.keys("\uE012", "\uE012"); // ArrowLeft x2
    await sleep(500);
    m = await mediaState(s);
    check("ArrowLeft ×2: −10 s", Math.abs(m.t - 15) < 0.6, String(m.t));
    await s.keys(" ");
    await sleep(900);
    m = await mediaState(s);
    check("Space plays", !m.paused && m.t > 15.1, JSON.stringify(m));
    await s.keys(" ");
    await sleep(300);
    check("Space pauses again", (await mediaState(s)).paused);
    // Keyboard on the transcript: Tab to a timestamp button, Enter seeks.
    await s.exec(`document.querySelectorAll('.transcript .segment-time')[1].focus();`);
    await s.keys(ENTER);
    await sleep(700);
    m = await mediaState(s);
    check("Enter on a focused timestamp seeks", Math.abs(m.t - segments[1].startMs / 1000) < 1.2, `t=${m.t}`);
    await s.exec(`${MEDIA}.pause();`);
    // Transcript filter.
    await setInput(s, ".transcript-filter", segments[0].text.split(/\s+/)[0].replace(/[^\p{L}]/gu, ""));
    await sleep(300);
    const fl = await s.exec(`return { n: document.querySelectorAll('.transcript .segment').length, marks: document.querySelectorAll('.transcript mark').length, st: document.querySelector('.transcript-head [role=status]')?.textContent };`);
    check("transcript filter narrows segments and marks matches", fl.n >= 1 && fl.n <= segments.length && fl.marks >= 1, JSON.stringify(fl));
    await setInput(s, ".transcript-filter", "");
    for (const [w, h, zoom] of [[480, 700, 1], [720, 700, 1], [1280, 800, 1], [1920, 1080, 1], [1280, 800, 2]]) {
      await wd("POST", s.p("/window/rect"), { width: w, height: h });
      await s.exec(`document.documentElement.style.zoom = arguments[0];`, [String(zoom)]);
      await sleep(600);
      const o = await s.exec(`const d = document.documentElement; const over = [...document.querySelectorAll('.media-viewer, .media-viewer *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1; }).slice(0, 4).map(e => e.className || e.tagName);
        return { iw: innerWidth, doc: d.scrollWidth > d.clientWidth + 1, over };`);
      check(`media viewer ${w}x${h} zoom ${zoom * 100}%: no horizontal overflow`, !o.doc && o.over.length === 0, JSON.stringify(o));
      await s.screenshot(`layout-${w}-z${zoom}`);
    }
    await s.exec(`document.documentElement.style.zoom = '1';`);
    await wd("POST", s.p("/window/rect"), { width: 1280, height: 800 });
  });

  // ================= 11. Restart persistence =================
  await section("restart", async () => {
    await sleep(1000);
    await s.quit();
    s = await openApp();
    await goLibrary(s);
    const rows = await s.rows();
    console.log(`      rows after restart: ${JSON.stringify(rows)}`);
    check("after restart: MP4 «Trascritta (Whisper tiny)», muto failed, MP3 «Da trascrivere»", rows[MP4]?.label === "Trascritta (Whisper tiny)" && rows["muto.mp4"]?.label === "Trascrizione non riuscita" && rows[MP3]?.label === "Da trascrivere", JSON.stringify(rows));
    await refreshDocs();
    const tr = (await s.invoke("get_transcript", { versionId: byTitle[MP4].current.id })).value;
    check("after restart: transcript identical", JSON.stringify(tr) === JSON.stringify(segments));
    const links = (await s.invoke("list_media_links", { mediaVersionId: byTitle[MP4].current.id })).value;
    check("after restart: 3 links (2 PDF, 1 photo)", links.length === 3 && links.filter((l) => l.targetTitle === "slide.pdf").length === 2, links.length);
    const jobs = (await s.invoke("list_jobs", { projectId })).value.filter((j) => j.kind === "transcribe");
    check("after restart: job states kept (done, cancelled, failed)", jobs.some((j) => j.state === "done") && jobs.some((j) => j.error === "Trascrizione annullata.") && jobs.some((j) => /codifica/.test(j.error ?? "")), jobs.map((j) => `${j.state}:${j.error}`).join(", "));
    await openDoc(s, MP4);
    await s.waitFor(`document.querySelectorAll('.transcript .segment').length === ${segments.length} && document.querySelectorAll('.link-row').length === 3`, "viewer after restart");
    check("after restart: viewer shows transcript and links", true);
  });

  // ================= 12. Whisper models: settings, downloads (fake HF) =================
  await section("models", async () => {
    await goSettings(s);
    await s.waitFor(`document.querySelectorAll('.whisper-model').length === 4`, "4 models");
    const list = await s.exec(`return [...document.querySelectorAll('.whisper-model')].map(li => li.textContent.replace(/\\s+/g, ' ').trim());`);
    console.log(`      models: ${JSON.stringify(list)}`);
    check("Impostazioni → Trascrizione: tiny «Installato», others «Da scaricare»", /Installato/.test(list[0]) && list.slice(1).every((t) => /Da scaricare/.test(t)), list.join(" | "));
    const note = await s.text(".transcription-settings > .hint");
    check("privacy note: on this computer, download only from huggingface.co", /questo computer/.test(note) && /huggingface\.co/.test(note), note);
    const reqs0 = fakeHf.requests.length;
    // Confirm dialog → Annulla: no request.
    await s.click(await s.find(`button[aria-label^="Scarica Whisper Base"]`));
    await s.waitFor(`document.querySelector('dialog[open]')?.textContent.includes('huggingface.co')`, "confirm dialog");
    const dt = await s.exec(`return document.querySelector('dialog[open]').textContent.replace(/\\s+/g, ' ');`);
    const sizeLabel = (list[1].match(/ggml-base\.bin · ([^A-Z]+?B)/) ?? [])[1];
    console.log(`      confirm: ${dt}`);
    check("download confirmation states huggingface.co, file name and size", /huggingface\.co/.test(dt) && /ggml-base\.bin/.test(dt) && sizeLabel && dt.includes(sizeLabel), `${sizeLabel} | ${dt.slice(0, 200)}`);
    await s.click(await s.findByText("dialog[@open]//button", "Annulla"));
    await s.waitFor(`!document.querySelector('dialog[open]')`, "confirm closed");
    await sleep(800);
    check("Annulla in the confirmation: no request sent", fakeHf.requests.length === reqs0, JSON.stringify(fakeHf.requests.slice(reqs0)));
    // Wrong SHA (correct size, zeros) through an allowed same-origin redirect.
    await s.click(await s.find(`button[aria-label^="Scarica Whisper Base"]`));
    await s.waitFor(`document.querySelector('dialog[open]')`, "confirm 2");
    await s.click(await s.findByText("dialog[@open]//button[contains(@class,'btn')]", `Scarica (${sizeLabel})`).catch(async () => s.find("dialog[open] .dialog-actions button:last-child")));
    const err = await s.waitFor(`(() => { const li = document.getElementById('whisper-model-base'); const e = li?.querySelector('.field-error'); return e ? e.textContent.trim() : false; })()`, "sha error", 60000);
    check("wrong bytes → «verifica SHA-256 non riuscita» shown on the model", /SHA-256/.test(err), err);
    check("…no ggml-base.bin and no partial file left", !existsSync(join(modelsDir, "ggml-base.bin")) && (listDir(modelsDir) ?? []).every((f) => !f.startsWith(".download-")), JSON.stringify(listDir(modelsDir)));
    // Cancel a slow download mid-way.
    await s.click(await s.find(`button[aria-label^="Scarica Whisper Small"]`));
    await s.waitFor(`document.querySelector('dialog[open]')`, "confirm 3");
    await s.click(await s.find("dialog[open] .dialog-actions button:last-child"));
    const prog = await s.waitFor(`(() => { const t = document.querySelector('#whisper-model-small .whisper-progress')?.textContent; return t && /Scaricamento [1-9]\\d* %|Scaricamento \\d+ % \\(\\d/.test(t) && !/\\(0 B/.test(t) ? t : false; })()`, "small progress", 60000);
    check("download progress shown (% and bytes)", /Scaricamento \d+ %/.test(prog), prog);
    const partial = (listDir(modelsDir) ?? []).filter((f) => f.startsWith(".download-"));
    check("partial file is a hidden temp in the models dir", partial.length === 1, JSON.stringify(partial));
    await s.click(await s.find(`button[aria-label="Annulla lo scaricamento di Whisper Small"]`));
    await s.waitFor(`/Da scaricare/.test(document.getElementById('whisper-model-small').textContent)`, "small cancelled", 20000);
    await sleep(800);
    check("cancelled download: back to «Da scaricare», temp removed, no file", !existsSync(join(modelsDir, "ggml-small.bin")) && (listDir(modelsDir) ?? []).every((f) => !f.startsWith(".download-")), JSON.stringify(listDir(modelsDir)));
    // Redirect to a non-allowed host.
    await s.click(await s.find(`button[aria-label^="Scarica Whisper Large"]`));
    await s.waitFor(`document.querySelector('dialog[open]')`, "confirm 4");
    await s.click(await s.find("dialog[open] .dialog-actions button:last-child"));
    const rerr = await s.waitFor(`(() => { const e = document.querySelector('#whisper-model-large-v3-turbo-q5 .field-error'); return e ? e.textContent.trim() : false; })()`, "redirect error", 30000);
    check("redirect to a non-allowed host → «indirizzo non consentito», host never contacted", /non consentito/.test(rerr) && fakeHf.evilHits.length === 0, `${rerr} evil=${fakeHf.evilHits.length}`);
    // Delete tiny (no job running) → start_transcription refused → re-download (real bytes) → installed.
    await s.click(await s.find(`button[aria-label="Elimina Whisper Tiny"]`));
    await s.waitFor(`document.querySelector('dialog[open]')`, "delete model confirm");
    await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
    await s.waitFor(`/Da scaricare/.test(document.getElementById('whisper-model-tiny').textContent)`, "tiny deleted");
    check("Elimina removes ggml-tiny.bin", !existsSync(join(modelsDir, "ggml-tiny.bin")));
    await refreshDocs();
    let r = await s.invoke("start_transcription", { versionId: byTitle[MP3].current.id, model: "tiny", language: "it" });
    check("start_transcription without the model installed → conflict «Modello non installato…»", !r.ok && r.err.code === "conflict" && /Modello non installato/.test(r.err.message), JSON.stringify(r.err));
    r = await s.invoke("start_transcription", { versionId: byTitle["slide.pdf"].current.id, model: "tiny", language: "it" });
    check("start_transcription on a PDF → refused", !r.ok, JSON.stringify(r.err));
    r = await s.invoke("start_transcription", { versionId: byTitle[MP3].current.id, model: "huge", language: "it" });
    check("start_transcription unknown model → validation", !r.ok && r.err.code === "validation", JSON.stringify(r.err));
    r = await s.invoke("download_whisper_model", { id: "../../evil" });
    check("download_whisper_model unknown id → validation", !r.ok && r.err.code === "validation", JSON.stringify(r.err));
    await s.click(await s.find(`button[aria-label^="Scarica Whisper Tiny"]`));
    await s.waitFor(`document.querySelector('dialog[open]')`, "confirm tiny");
    await s.click(await s.find("dialog[open] .dialog-actions button:last-child"));
    await s.waitFor(`/Installato/.test(document.getElementById('whisper-model-tiny').textContent)`, "tiny downloaded", 120000);
    sampleNet();
    check("tiny downloaded from the fake HF, verified and installed (sha256)", (await sha256File(join(modelsDir, "ggml-tiny.bin"))) === TINY_SHA);
    const paths = fakeHf.requests.map((x) => x.url);
    check("fake HF saw only the expected catalog paths", paths.every((p) => p.startsWith(HF_PATH) || p.startsWith("/cdn/")), JSON.stringify(paths));
    // Transcribe the MP3 with the re-downloaded model, to close the loop.
    r = await s.invoke("start_transcription", { versionId: byTitle[MP3].current.id, model: "tiny", language: "auto" });
    const job = await waitJob(s, byTitle[MP3].current.id, (j) => j.state === "done" || j.state === "failed", "mp3 transcription", 600000);
    await refreshDocs();
    check("MP3 transcribed (auto language) with the downloaded model; detected language recorded", job.state === "done" && byTitle[MP3].current.transcription?.segmentCount > 0 && /^[a-z]{2}$/.test(byTitle[MP3].current.transcription.language), JSON.stringify(byTitle[MP3].current.transcription));
  });

  // ================= 13. Network =================
  sampleNet();
  const allowed = new Set([new URL(fakeHf.url).host, new URL(fakeLm.url).host]);
  const foreign = net.filter((h) => !allowed.has(h) && !/^127\.0\.0\.1:(4484|4485)$/.test(h));
  console.log(`      app TCP peers sampled: ${[...new Set(net)].join(", ")}`);
  check("app connections only to the loopback fakes (lsof samples)", foreign.length === 0, foreign.join(", "));

  // ================= 14. Delete the media document =================
  await section("delete media", async () => {
    await goLibrary(s);
    const mp4 = byTitle[MP4];
    const vId = mp4.current.id;
    await openDoc(s, MP4);
    if (!(await s.exec(`return !!document.querySelector('.info-panel');`))) await s.click(await s.findByText("button", "Informazioni"));
    await s.exec(`document.querySelector('.info-actions .btn-danger-quiet').scrollIntoView({ block: 'center' });`);
    await s.click(await s.find(".info-actions .btn-danger-quiet"));
    await s.waitFor(`document.querySelector('dialog[open]')`, "delete doc confirm");
    const t = await s.text("dialog[open]");
    console.log(`      delete dialog: ${t}`);
    await s.click(await s.findByText("dialog[@open]//button", "Elimina"));
    await s.waitFor(`!document.querySelector('dialog[open]') && !document.querySelector(${JSON.stringify(`.doc-open[title="${MP4}"]`)})`, "doc deleted");
    const tr = await s.invoke("get_transcript", { versionId: vId });
    check("deleted media: get_transcript → not_found", !tr.ok && tr.err.code === "not_found", JSON.stringify(tr));
    const rows = {};
    for (const table of ["transcriptions", "transcript_segments", "media_links", "document_text", "chunks", "jobs"]) {
      const col = table === "media_links" ? "media_version_id" : "version_id";
      rows[table] = (await db(dbPath, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, vId))[0].n;
    }
    check("deleted media: no transcription, segments, links, text, chunks, jobs left (DB)", Object.values(rows).every((n) => n === 0), JSON.stringify(rows));
    const back = (await s.invoke("list_links_for_target", { targetVersionId: byTitle["slide.pdf"].current.id })).value;
    check("PDF has no backlinks any more", back.length === 0, back.length);
    check("MP4 blob removed from originals/", !existsSync(blobPath(F[MP4].sha)));
    check("slide.pdf and PNG untouched (blobs, sha256)", sha256(readFileSync(blobPath(F["slide.pdf"].sha))) === F["slide.pdf"].sha && sha256(readFileSync(blobPath(F["foto-appunti.png"].sha))) === F["foto-appunti.png"].sha);
    check("user's source files untouched", sha256(readFileSync(F[MP4].path)) === F[MP4].sha);
    await openDoc(s, "slide.pdf");
    await sleep(800);
    check("PDF viewer shows no backlinks", !(await s.exec(`return !!document.querySelector('.backlink');`)));
    const errs = await s.exec(`return window.__qa;`);
    check("no uncaught errors or CSP violations in the webview (since restart)", errs.errors.length === 0 && errs.csp.length === 0, JSON.stringify({ e: errs.errors, c: errs.csp }));
    check("webview made no fetch() calls", errs.fetches.length === 0, JSON.stringify(errs.fetches));
  });
  await s.quit().catch(() => {});
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
