// TEST FIXTURE — a fake LM Studio server for the native chat E2E (e2e/chat.mjs).
// It is NOT a language model and NOT an embedding model: answers are assembled mechanically
// from the prompt it receives (it echoes the first words of source [1]) and "embeddings" are
// deterministic token-hash vectors (same words → close vectors). Plain Node >= 22, no deps.
//
// Listens on 127.0.0.1 only (port 0 = a free port, reported by `start()`). Endpoints, shaped
// like LM Studio's OpenAI-compatible API:
//   GET  /api/v0/models         one "llm" and one "embeddings" model (LM Studio native list)
//   GET  /v1/models             same ids, OpenAI shape
//   POST /v1/embeddings         {model, input: string[]} → L2-normalisable token-hash vectors
//   POST /v1/chat/completions   {stream: true} → SSE `data: {choices:[{delta:{content}}]}` … `[DONE]`
//
// Switches (set on the returned object at any time):
//   fake.mode.chat       "default" | "error500" | "slow" | "custom"
//   fake.mode.embeddings "ok" | "error500"
//   fake.mode.chunkDelayMs   delay between SSE pieces (default 5; "slow" uses slowDelayMs)
//   fake.mode.slowDelayMs    default 400
//   fake.mode.answer         string or (prompt) => string, used when chat === "custom"
// Every request (method, path, Host header, parsed JSON body) is kept in `fake.requests` and,
// when `recordFile` is given, appended to it as one JSON line.
//
// Usage:
//   import { startFakeLmStudio } from "./fake-lmstudio.mjs";
//   const fake = await startFakeLmStudio({ recordFile });
//   ... fake.url (e.g. http://127.0.0.1:43127) ...
//   await fake.close();

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

export const CHAT_MODEL = "qa-fake-chat";
export const EMBEDDING_MODEL = "qa-fake-embed";
const DIM = 64;

function normalizeWords(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
}

/** Deterministic bag-of-words vector (FNV-1a hash of each word into DIM buckets). */
export function tokenHashVector(text) {
  const v = new Array(DIM).fill(0);
  for (const w of normalizeWords(text)) {
    let h = 0x811c9dc5;
    for (const ch of w) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    v[h % DIM] += 1;
  }
  if (v.every((x) => x === 0)) v[0] = 1; // never a zero vector
  return v;
}

/** The answer of the default mode, built only from what the prompt contains. */
export function defaultAnswer(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const m = last.match(/--- inizio fonte \[1\] ---\n([\s\S]*?)\n--- fine fonte \[1\] ---/);
  const echo = m ? m[1].split(/\s+/).filter(Boolean).slice(0, 6).join(" ") : "(nessuna fonte)";
  return [
    `Risposta di prova del server finto: la fonte dice «${echo}» [1]. Un riferimento inesistente [99].`,
    "",
    "Formula inline $E = mc^2$ e anche \\(a^2 + b^2 = c^2\\).",
    "",
    "$$\\int_0^1 x\\,dx = \\frac{1}{2}$$",
    "",
    "\\[\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\\]",
    "",
    "| Colonna | Valore |",
    "| --- | --- |",
    "| alfa | 1 |",
    "| beta | 2 |",
    "",
    "```python",
    "x = fonti[2]  # [2] dentro il codice non è una citazione",
    "```",
    "",
  ].join("\n");
}

function pieces(text, size = 7) {
  const out = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFakeLmStudio({ recordFile = null, port = 0 } = {}) {
  const fake = {
    requests: [],
    mode: { chat: "default", embeddings: "ok", chunkDelayMs: 5, slowDelayMs: 400, answer: null },
    url: null,
    port: null,
    /** Requests to a path (e.g. "/v1/chat/completions"). */
    count(path) {
      return this.requests.filter((r) => r.path === path).length;
    },
    lastChat() {
      return [...this.requests].reverse().find((r) => r.path === "/v1/chat/completions") ?? null;
    },
  };
  const sockets = new Set();

  const server = createServer(async (req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { unparsable: raw.slice(0, 200) };
    }
    const path = (req.url ?? "").split("?")[0];
    const record = { t: Date.now(), method: req.method, path, host: req.headers.host, remote: req.socket.remoteAddress, body };
    fake.requests.push(record);
    if (recordFile) appendFileSync(recordFile, JSON.stringify(record) + "\n");

    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };

    if (req.method === "GET" && path === "/api/v0/models") {
      return json(200, {
        object: "list",
        data: [
          { id: CHAT_MODEL, object: "model", type: "llm", state: "loaded" },
          { id: EMBEDDING_MODEL, object: "model", type: "embeddings", state: "loaded" },
        ],
      });
    }
    if (req.method === "GET" && path === "/v1/models") {
      return json(200, { object: "list", data: [{ id: CHAT_MODEL, object: "model" }, { id: EMBEDDING_MODEL, object: "model" }] });
    }
    if (req.method === "POST" && path === "/v1/embeddings") {
      if (fake.mode.embeddings === "error500") return json(500, { error: { message: "fake embeddings failure" } });
      const input = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
      return json(200, {
        object: "list",
        model: body?.model,
        data: input.map((text, index) => ({ object: "embedding", index, embedding: tokenHashVector(text) })),
      });
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      if (fake.mode.chat === "error500") return json(500, { error: { message: "fake chat failure" } });
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      let text;
      if (fake.mode.chat === "custom") {
        text = typeof fake.mode.answer === "function" ? fake.mode.answer(messages) : String(fake.mode.answer ?? "");
      } else {
        text = defaultAnswer(messages);
      }
      const delay = fake.mode.chat === "slow" ? fake.mode.slowDelayMs : fake.mode.chunkDelayMs;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
      let closed = false;
      res.on("close", () => (closed = true));
      for (const p of pieces(text)) {
        if (closed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
        await sleep(delay);
      }
      if (!closed) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }
    json(404, { error: { message: `fake: no route ${req.method} ${path}` } });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  fake.port = server.address().port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  fake.close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(() => r()));
  };
  return fake;
}

// `node e2e/fake-lmstudio.mjs` runs it standalone (Ctrl+C to stop) for manual checks.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeLmStudio();
  console.log(`fake LM Studio (test fixture, not a model) on ${fake.url}`);
  process.on("SIGINT", async () => {
    await fake.close();
    process.exit(0);
  });
}
