// TEST FIXTURE — fake cloud provider servers for the native cloud E2E (e2e/cloud.mjs).
// They are NOT language models, NOT embedding models and NOT the real provider APIs: answers are
// assembled mechanically from the prompt they receive (they echo the first words of source [1]),
// "embeddings" are deterministic token-hash vectors and token usage is a made-up count
// (characters / 4). They only imitate the wire shapes Localis uses, so a test against them proves
// Localis' plumbing (routing, consent, payload, streaming, usage, logging), never compatibility
// with the real services. Plain Node >= 22, no dependencies. Listens on 127.0.0.1 only.
//
// One loopback HTTP server per provider (the debug-only LOCALIS_TEST_<PROVIDER>_BASE_URL override
// points each provider at its own origin):
//   openai     GET /v1/models · POST /v1/chat/completions (SSE + usage chunk) · POST /v1/embeddings
//   deepseek   GET /models · POST /chat/completions
//   qwen       GET /compatible-mode/v1/models · POST …/chat/completions · POST …/embeddings
//   anthropic  GET /v1/models · POST /v1/messages (SSE message_start/content_block_delta/message_delta/message_stop)
//   gemini     GET /v1beta/models · POST /v1beta/models/<m>:streamGenerateContent?alt=sse · POST …:batchEmbedContents
//
// Authentication: each provider expects its own key (given to `startFakeCloud({ keys })`) in its
// header (Authorization: Bearer / x-api-key / x-goog-api-key). A wrong or missing key → 401.
// The recorder NEVER stores a key: only which auth header was present, its length, a short
// sha256 prefix and whether it matched.
//
// Switches, per provider, at any time:  fake.mode[provider] = "ok" | "401" | "429" | "500" | "slow"
//   fake.mode.chunkDelayMs (default 5), fake.mode.slowDelayMs (default 300)
// Every request is kept in `fake.requests` ({ t, provider, method, path, query, host, remote,
// auth: { header, len, sha8, ok }, body }) and, with `recordFile`, appended as one JSON line.
//
// Usage:
//   import { startFakeCloud } from "./fake-cloud.mjs";
//   const fake = await startFakeCloud({ keys: { openai: "sk-TEST-SENTINEL-…", … }, recordFile });
//   fake.urls.openai → http://127.0.0.1:<port>;  fake.env → { LOCALIS_TEST_OPENAI_BASE_URL: …, … }
//   await fake.close();

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tokenHashVector } from "./fake-lmstudio.mjs";

export const PROVIDERS = ["openai", "anthropic", "gemini", "deepseek", "qwen"];
export const MODELS = {
  openai: { chat: "gpt-qa-mini", embedding: "text-embedding-qa-small" },
  anthropic: { chat: "claude-qa-haiku" },
  gemini: { chat: "gemini-qa-flash", embedding: "gemini-qa-embedding" },
  deepseek: { chat: "deepseek-qa-chat" },
  qwen: { chat: "qwen-qa-plus", embedding: "text-embedding-qa-v3" },
};
const PREFIX = { openai: "/v1", anthropic: "/v1", gemini: "/v1beta", deepseek: "", qwen: "/compatible-mode/v1" };
const ENV = {
  openai: "LOCALIS_TEST_OPENAI_BASE_URL",
  anthropic: "LOCALIS_TEST_ANTHROPIC_BASE_URL",
  gemini: "LOCALIS_TEST_GEMINI_BASE_URL",
  deepseek: "LOCALIS_TEST_DEEPSEEK_BASE_URL",
  qwen: "LOCALIS_TEST_QWEN_BASE_URL",
};

export const sha8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Answer built only from the prompt: echoes the first words of source [1] and cites it. */
export function fakeCloudAnswer(provider, promptText) {
  const m = promptText.match(/--- inizio fonte \[1\] [0-9a-f]+ ---\n([\s\S]*?)\n--- fine fonte \[1\] [0-9a-f]+ ---/);
  const echo = m ? m[1].split(/\s+/).filter(Boolean).slice(0, 6).join(" ") : "(nessuna fonte)";
  return `Risposta di prova del server finto ${provider}: la fonte dice «${echo}» [1].`;
}
function pieces(text, size = 9) {
  const out = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}
const estTokens = (chars) => Math.max(1, Math.ceil(chars / 4));

function authOf(provider, headers, expected) {
  let header = null;
  let key = null;
  if (provider === "anthropic") {
    if (headers["x-api-key"] !== undefined) [header, key] = ["x-api-key", headers["x-api-key"]];
  } else if (provider === "gemini") {
    if (headers["x-goog-api-key"] !== undefined) [header, key] = ["x-goog-api-key", headers["x-goog-api-key"]];
  } else if (headers.authorization !== undefined) {
    header = "authorization";
    key = /^Bearer /.test(headers.authorization) ? headers.authorization.slice(7) : "";
  }
  return { header, len: key ? key.length : 0, sha8: key ? sha8(key) : null, ok: key !== null && key === expected };
}

export async function startFakeCloud({ keys = {}, recordFile = null } = {}) {
  const fake = {
    requests: [],
    mode: { chunkDelayMs: 5, slowDelayMs: 300, ...Object.fromEntries(PROVIDERS.map((p) => [p, "ok"])) },
    urls: {},
    env: {},
    /** Requests of a provider, optionally filtered by a path suffix. */
    of(provider, suffix = "") {
      return this.requests.filter((r) => r.provider === provider && r.path.endsWith(suffix));
    },
    count() {
      return this.requests.length;
    },
  };
  const servers = [];
  const sockets = new Set();

  for (const provider of PROVIDERS) {
    const prefix = PREFIX[provider];
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
      const [path, query = ""] = (req.url ?? "").split("?");
      const auth = authOf(provider, req.headers, keys[provider]);
      const record = { t: Date.now(), provider, method: req.method, path, query, host: req.headers.host, remote: req.socket.remoteAddress,
        headers: Object.keys(req.headers).sort(), anthropicVersion: req.headers["anthropic-version"] ?? null, auth, body };
      fake.requests.push(record);
      if (recordFile) appendFileSync(recordFile, JSON.stringify(record) + "\n");
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const mode = fake.mode[provider];
      if (!auth.ok || mode === "401") return json(401, { error: { message: "fake: invalid API key", type: "invalid_request_error" } });
      if (mode === "429") return json(429, { error: { message: "fake: rate limited" } });
      if (mode === "500") return json(500, { error: { message: "fake: server error" } });
      const delay = mode === "slow" ? fake.mode.slowDelayMs : fake.mode.chunkDelayMs;
      const sse = async (events, { done = false } = {}) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        let closed = false;
        res.on("close", () => (closed = true));
        for (const [name, data] of events) {
          if (closed) return;
          res.write(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
          await sleep(delay);
        }
        if (done && !closed) res.write("data: [DONE]\n\n");
        if (!closed) res.end();
      };
      const models = MODELS[provider];

      // ---- models
      if (req.method === "GET" && path === `${prefix}/models`) {
        if (provider === "gemini") {
          return json(200, {
            models: [
              { name: `models/${models.chat}`, supportedGenerationMethods: ["generateContent", "countTokens"] },
              { name: `models/${models.embedding}`, supportedGenerationMethods: ["embedContent", "batchEmbedContents"] },
            ],
          });
        }
        if (provider === "anthropic") return json(200, { data: [{ id: models.chat, type: "model" }], has_more: false, last_id: models.chat });
        return json(200, { object: "list", data: Object.values(models).map((id) => ({ id, object: "model" })) });
      }
      // ---- OpenAI-compatible chat
      if (req.method === "POST" && path === `${prefix}/chat/completions` && provider !== "anthropic" && provider !== "gemini") {
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        const promptChars = msgs.reduce((n, m) => n + String(m.content ?? "").length, 0);
        const text = fakeCloudAnswer(provider, msgs.at(-1)?.content ?? "");
        const ev = [[null, { choices: [{ index: 0, delta: { role: "assistant" } }] }]];
        for (const p of pieces(text)) ev.push([null, { choices: [{ index: 0, delta: { content: p } }] }]);
        ev.push([null, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
        ev.push([null, { choices: [], usage: { prompt_tokens: estTokens(promptChars), completion_tokens: pieces(text).length, total_tokens: 0 } }]);
        return sse(ev, { done: true });
      }
      // ---- Anthropic messages
      if (provider === "anthropic" && req.method === "POST" && path === "/v1/messages") {
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        const promptChars = msgs.reduce((n, m) => n + String(m.content ?? "").length, 0) + String(body?.system ?? "").length;
        const text = fakeCloudAnswer(provider, msgs.at(-1)?.content ?? "");
        const ev = [["message_start", { type: "message_start", message: { id: "msg_fake", usage: { input_tokens: estTokens(promptChars), output_tokens: 1 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["ping", { type: "ping" }]];
        for (const p of pieces(text)) ev.push(["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }]);
        ev.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
        ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: pieces(text).length } }]);
        ev.push(["message_stop", { type: "message_stop" }]);
        return sse(ev);
      }
      // ---- Gemini
      const gm = path.match(/^\/v1beta\/models\/([^:/]+):(streamGenerateContent|batchEmbedContents)$/);
      if (provider === "gemini" && req.method === "POST" && gm) {
        if (gm[2] === "batchEmbedContents") {
          const reqs = Array.isArray(body?.requests) ? body.requests : [];
          return json(200, { embeddings: reqs.map((r) => ({ values: tokenHashVector(r?.content?.parts?.[0]?.text ?? "") })) });
        }
        const contents = Array.isArray(body?.contents) ? body.contents : [];
        const textOf = (c) => (c?.parts ?? []).map((p) => p.text ?? "").join("");
        const promptChars = contents.reduce((n, c) => n + textOf(c).length, 0) + textOf(body?.systemInstruction).length;
        const text = fakeCloudAnswer(provider, textOf(contents.at(-1)));
        const ps = pieces(text);
        const ev = ps.map((p, i) => [null, { candidates: [{ content: { role: "model", parts: [{ text: p }] }, ...(i === ps.length - 1 ? { finishReason: "STOP" } : {}) }],
          usageMetadata: { promptTokenCount: estTokens(promptChars), candidatesTokenCount: i + 1 } }]);
        return sse(ev);
      }
      // ---- OpenAI-compatible embeddings
      if (req.method === "POST" && path === `${prefix}/embeddings` && (provider === "openai" || provider === "qwen")) {
        const input = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
        const chars = input.reduce((n, t) => n + String(t).length, 0);
        return json(200, { object: "list", model: body?.model, data: input.map((t, index) => ({ object: "embedding", index, embedding: tokenHashVector(t) })),
          usage: { prompt_tokens: estTokens(chars), total_tokens: estTokens(chars) } });
      }
      json(404, { error: { message: `fake ${provider}: no route ${req.method} ${path}` } });
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    fake.urls[provider] = `http://127.0.0.1:${server.address().port}`;
    fake.env[ENV[provider]] = fake.urls[provider];
  }
  fake.close = async () => {
    for (const s of sockets) s.destroy();
    await Promise.all(servers.map((srv) => new Promise((r) => srv.close(() => r()))));
  };
  return fake;
}

// `node e2e/fake-cloud.mjs` runs the fixtures standalone (Ctrl+C to stop) with sentinel keys.
if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = Object.fromEntries(PROVIDERS.map((p) => [p, `sk-TEST-SENTINEL-${p}`]));
  const fake = await startFakeCloud({ keys });
  console.log("fake cloud providers (test fixtures, not models):", fake.env);
  process.on("SIGINT", async () => {
    await fake.close();
    process.exit(0);
  });
}
