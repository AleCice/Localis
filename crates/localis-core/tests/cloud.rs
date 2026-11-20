//! Cloud integration tests (v0.4): Model Mesh providers, PRISM routing, confirmation
//! tokens, consent, cloud embeddings, cost and the cloud log, against fake provider servers
//! on loopback (test fixtures). No real key, no external network. The fake servers are
//! reached through the test-only endpoint override, which exists only in debug builds.
#![cfg(debug_assertions)]

mod common;

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::fake_cloud::{
    FakeCloud, Mode, ANTHROPIC_USAGE, CLOUD_ANSWER, EMBED_USAGE, GEMINI_USAGE, OPENAI_USAGE,
};
use common::fake_lm::{closed_url, FakeLm, CHAT_MODEL};
use common::keys::{MemoryKeys, UnavailableKeys};
use common::*;
use localis_core::{
    list_provider_models, prepare_cloud_send, run_embedder, send_message, ChatEvent, ChatMessage,
    ChatRuntime, CloudClient, CloudPolicy, CloudPreview, CloudProvider, CloudPurpose, CloudRuntime,
    CoreError, EmbedderConfig, EmbedderShared, EmbeddingState, Endpoints, ImportFile,
    ImportOutcome, Keys, LibraryDocument, LlmSettings, MessageKind, MessageStatus, ModelClient,
    ModelKind, ModelPrice, ModelRef, NewProject, ProviderId, RetrievalMode, Routing, SecretStore,
    SendInput, Store, MANUAL_REASON, ROUTE_CHANGED, TOKEN_INVALID, TOKEN_MISMATCH,
};
use tempfile::TempDir;

/// Sentinel API key: must never appear in the database, errors, events or logs.
const KEY: &str = "sk-SENTINEL-7f3a9c11-localis-test-key";
const OPENAI: ProviderId = ProviderId::Cloud(CloudProvider::OpenAi);
const ANALISI: &str = "La derivata di una funzione misura la variazione istantanea del valore.\n\n\
Il teorema di Rolle afferma che una funzione continua e derivabile con valori uguali agli estremi \
ha almeno un punto a derivata nulla.";
const STORIA: &str = "La rivoluzione francese iniziò nel 1789 con la presa della Bastiglia.";
const CHIMICA: &str = "La tavola periodica ordina gli elementi chimici per numero atomico.";
const Q: &str = "Che cosa misura la derivata?";
const EMBED: &str = "text-embedding-fake";

fn cloud_model(p: CloudProvider) -> ModelRef {
    let id = if p == CloudProvider::Gemini {
        "gemini-fake"
    } else {
        "chat-fake"
    };
    ModelRef::new(ProviderId::Cloud(p), id)
}

struct T {
    dir: TempDir,
    db: Mutex<Store>,
    rt: ChatRuntime,
    cloud: CloudRuntime,
    lm: FakeLm,
    fakes: HashMap<CloudProvider, FakeCloud>,
    project: String,
}

impl T {
    fn new(policy: CloudPolicy) -> Self {
        Self::build(policy, None, None)
    }

    fn build(policy: CloudPolicy, ttl: Option<Duration>, keys: Option<Keys>) -> Self {
        let mut env = Env::new();
        let project = env.project("Studio").id;
        env.store
            .set_project_cloud_policy(&project, policy)
            .unwrap();
        let lm = FakeLm::start();
        env.store
            .set_llm_settings(&LlmSettings {
                base_url: lm.url.clone(),
                chat_model: Some(cloud_model(CloudProvider::OpenAi)),
                ..LlmSettings::default()
            })
            .unwrap();
        let mut fakes = HashMap::new();
        let mut endpoints = Endpoints::default();
        for p in CloudProvider::ALL {
            let fake = FakeCloud::start(p, KEY);
            endpoints = endpoints.with_test_override(p, &fake.url).unwrap();
            fakes.insert(p, fake);
        }
        let keys: Keys = keys
            .unwrap_or_else(|| Arc::new(MemoryKeys::with(&CloudProvider::ALL.map(|p| (p, KEY)))));
        let mut cloud = CloudRuntime::new(keys, endpoints);
        if let Some(ttl) = ttl {
            cloud = cloud.with_ttl(ttl);
        }
        let Env { dir, store } = env;
        T {
            dir,
            db: Mutex::new(store),
            rt: ChatRuntime::new(),
            cloud,
            lm,
            fakes,
            project,
        }
    }

    fn fake(&self, p: CloudProvider) -> &FakeCloud {
        &self.fakes[&p]
    }

    fn total_cloud_requests(&self) -> usize {
        self.fakes.values().map(FakeCloud::count).sum()
    }

    fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.db.lock().unwrap()
    }

    fn settings(&self, f: impl FnOnce(&mut LlmSettings)) {
        let mut store = self.store();
        let mut s = store.llm_settings().unwrap();
        f(&mut s);
        store.set_llm_settings(&s).unwrap();
    }

    fn import_into(&self, project: &str, name: &str, bytes: &[u8]) -> LibraryDocument {
        let mut store = self.store();
        let file = ImportFile::prepare(name, None, bytes).unwrap();
        let doc = match store.import_document(project, None, &file).unwrap() {
            ImportOutcome::Imported(d) => d,
            ImportOutcome::Duplicate(d) => panic!("duplicate {d:?}"),
        };
        while store.run_next_job(TIMEOUT).unwrap() {}
        doc
    }

    fn import(&self, name: &str, text: &str) -> LibraryDocument {
        self.import_into(&self.project, name, text.as_bytes())
    }

    fn conversation(&self) -> String {
        self.store().create_conversation(&self.project).unwrap().id
    }

    fn input(conv: &str, text: &str, docs: &[&str], token: Option<&str>) -> SendInput {
        SendInput {
            conversation_id: conv.into(),
            text: text.into(),
            document_ids: docs.iter().map(|d| (*d).to_owned()).collect(),
            confirm_token: token.map(str::to_owned),
        }
    }

    fn prepare(&self, conv: &str, text: &str) -> Result<Option<CloudPreview>, CoreError> {
        prepare_cloud_send(&self.db, &self.cloud, &Self::input(conv, text, &[], None))
    }

    fn send_input(&self, input: SendInput) -> (Result<ChatMessage, CoreError>, Vec<ChatEvent>) {
        let mut events = Vec::new();
        let r = send_message(&self.db, &self.rt, &self.cloud, input, &mut |e| {
            events.push(e)
        });
        (r, events)
    }

    fn send(
        &self,
        conv: &str,
        text: &str,
        token: Option<&str>,
    ) -> (Result<ChatMessage, CoreError>, Vec<ChatEvent>) {
        self.send_input(Self::input(conv, text, &[], token))
    }

    /// prepare + confirmed send.
    fn ask_cloud(&self, conv: &str, text: &str) -> (CloudPreview, ChatMessage) {
        let preview = self.prepare(conv, text).unwrap().expect("a cloud preview");
        let message = self.send(conv, text, Some(&preview.token)).0.unwrap();
        (preview, message)
    }

    fn count(&self, sql: &str) -> i64 {
        rusqlite::Connection::open(self.dir.path().join("localis.db"))
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }

    fn messages(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM messages")
    }

    fn new_project(&self, name: &str, policy: CloudPolicy) -> String {
        let mut store = self.store();
        let p = store
            .create_project(NewProject {
                name: name.into(),
                description: None,
            })
            .unwrap();
        store.set_project_cloud_policy(&p.id, policy).unwrap();
        p.id
    }

    fn start_embedder(&self, config: EmbedderConfig) -> Embedder {
        let path = self.dir.path().join("localis.db");
        let (tx, rx) = mpsc::sync_channel(1);
        let shared = EmbedderShared::new();
        let thread_shared = Arc::clone(&shared);
        let env = self.cloud.env.clone();
        let handle = std::thread::spawn(move || {
            run_embedder(|| Store::open(&path), rx, thread_shared, config, env)
        });
        Embedder {
            wake: Some(tx),
            handle: Some(handle),
            shared,
        }
    }
}

struct Embedder {
    wake: Option<mpsc::SyncSender<()>>,
    handle: Option<std::thread::JoinHandle<()>>,
    shared: Arc<EmbedderShared>,
}

impl Embedder {
    fn wake(&self) {
        let _ = self.wake.as_ref().unwrap().try_send(());
    }
}

impl Drop for Embedder {
    fn drop(&mut self) {
        drop(self.wake.take());
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn fast() -> EmbedderConfig {
    EmbedderConfig {
        batch_size: 64,
        idle_poll: Duration::from_millis(30),
        initial_backoff: Duration::from_secs(30),
        max_backoff: Duration::from_secs(30),
        batch_timeout: Duration::from_secs(10),
    }
}

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_consent(r: Result<impl std::fmt::Debug, CoreError>, message: Option<&str>) {
    let err = r.expect_err("consent_required expected");
    assert_eq!(err.code(), "consent_required", "{err:?}");
    if let Some(m) = message {
        assert_eq!(err.to_string(), m);
    }
}

fn chat_requests(fake: &FakeCloud) -> Vec<common::fake_cloud::Recorded> {
    fake.requests()
        .into_iter()
        .filter(|r| {
            r.path.contains("chat/completions")
                || r.path.contains("/messages")
                || r.path.contains("GenerateContent")
        })
        .collect()
}

// ------------------------------------------------------------------ privacy

#[test]
fn local_only_blocks_every_cloud_path() {
    let t = T::new(CloudPolicy::LocalOnly);
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();

    // Manual cloud chat model: refused before anything is stored or sent.
    assert_consent(t.prepare(&conv, Q), None);
    let (r, events) = t.send(&conv, Q, None);
    assert_consent(r, None);
    assert!(events.is_empty());
    let (r, _) = t.send(&conv, Q, Some("00000000-0000-4000-8000-000000000000"));
    assert_consent(r, None);
    // Even an inventory question: the configured model is not allowed for this project.
    assert_consent(t.send(&conv, "Quali documenti ho caricato?", None).0, None);
    assert_eq!(t.messages(), 0);

    // Automatic routing never picks a cloud candidate for a local-only project.
    t.settings(|s| {
        s.routing = Routing::Auto;
        s.auto_models = vec![
            cloud_model(CloudProvider::OpenAi),
            cloud_model(CloudProvider::Anthropic),
        ];
    });
    assert!(t.prepare(&conv, Q).unwrap().is_none());
    let m = t.send(&conv, Q, None).0.unwrap();
    assert_eq!(m.status, MessageStatus::Error);
    let err = m.error.unwrap();
    assert_eq!(err.code, "llm_unavailable");
    assert!(err.message.contains("«Solo locale»"), "{}", err.message);
    // …and uses the local candidate when there is one.
    t.settings(|s| s.auto_models.push(ModelRef::lmstudio(CHAT_MODEL)));
    let m = t.send(&conv, Q, None).0.unwrap();
    assert_eq!(m.status, MessageStatus::Complete);
    assert_eq!(m.provider, Some(ProviderId::LmStudio));

    // Cloud embeddings: no consent possible, no indexing, no query embedding.
    t.settings(|s| s.embedding_model = Some(ModelRef::new(OPENAI, EMBED)));
    let err = t
        .store()
        .set_cloud_embedding_consent(&t.project, true)
        .unwrap_err();
    assert_eq!(err.code(), "conflict");
    // Vectors computed earlier (e.g. before the project became local-only) are not used
    // for cloud query embeddings.
    {
        let mut store = t.store();
        let key = ModelRef::new(OPENAI, EMBED).embedding_key();
        let pending = store.pending_embeddings(&key, 100).unwrap();
        let items: Vec<(i64, Vec<f32>)> = pending
            .iter()
            .map(|(id, _)| (*id, vec![1.0, 0.0]))
            .collect();
        store.save_embeddings(&key, &items).unwrap();
    }
    let embedder = t.start_embedder(fast());
    std::thread::sleep(Duration::from_millis(300));
    let m = t.send(&conv, Q, None).0.unwrap();
    assert_eq!(m.retrieval.unwrap().mode, RetrievalMode::Lexical);
    let st = t
        .store()
        .embedding_status(&t.project, &embedder.shared)
        .unwrap();
    assert_eq!(st.state, EmbeddingState::NeedsConsent);
    assert_eq!(st.provider, Some(OPENAI));
    drop(embedder);

    assert_eq!(
        t.total_cloud_requests(),
        0,
        "no request ever reached a cloud provider"
    );
    assert_eq!(t.count("SELECT COUNT(*) FROM cloud_requests"), 0);
}

// ------------------------------------------------------------------ tokens

#[test]
fn tokens_are_single_use_bound_and_expire() {
    let t = T::new(CloudPolicy::CloudAllowed);
    let doc = t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    let other = t.conversation();
    let openai = t.fake(CloudProvider::OpenAi);

    let p = t.prepare(&conv, Q).unwrap().unwrap();
    assert!(
        chat_requests(openai).is_empty(),
        "prepare never calls the chat model"
    );
    assert_eq!(t.messages(), 0, "prepare stores nothing");
    assert_eq!(p.token.len(), 36);

    // No token / altered token.
    assert_consent(t.send(&conv, Q, None).0, None);
    let mut altered = p.token.clone();
    let last = altered.pop().unwrap();
    altered.push(if last == 'a' { 'b' } else { 'a' });
    assert_consent(t.send(&conv, Q, Some(&altered)).0, Some(TOKEN_INVALID));
    // Different question: refused, and the token is consumed by that attempt.
    assert_consent(
        t.send(&conv, "Che cosa dice il teorema di Rolle?", Some(&p.token))
            .0,
        Some(TOKEN_MISMATCH),
    );
    assert_consent(t.send(&conv, Q, Some(&p.token)).0, Some(TOKEN_INVALID));
    // Different conversation, different selection.
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    assert_consent(t.send(&other, Q, Some(&p.token)).0, Some(TOKEN_MISMATCH));
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    let (r, _) = t.send_input(T::input(&conv, Q, &[&doc.id], Some(&p.token)));
    assert_consent(r, Some(TOKEN_MISMATCH));
    // Discarded.
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    t.cloud.discard(&p.token);
    assert_consent(t.send(&conv, Q, Some(&p.token)).0, Some(TOKEN_INVALID));
    // Model choice changed after the preview.
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    t.settings(|s| s.chat_model = Some(cloud_model(CloudProvider::Anthropic)));
    assert_consent(t.send(&conv, Q, Some(&p.token)).0, Some(ROUTE_CHANGED));
    t.settings(|s| s.chat_model = Some(cloud_model(CloudProvider::OpenAi)));
    // Project made local-only after the preview.
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    t.store()
        .set_project_cloud_policy(&t.project, CloudPolicy::LocalOnly)
        .unwrap();
    assert_consent(t.send(&conv, Q, Some(&p.token)).0, None);
    t.store()
        .set_project_cloud_policy(&t.project, CloudPolicy::CloudAllowed)
        .unwrap();
    assert_eq!(t.messages(), 0, "no failed attempt stored anything");
    assert!(
        chat_requests(openai).is_empty(),
        "no failed attempt reached the provider"
    );

    // Valid: sent once; the same token cannot be reused.
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    let selection_ok = t
        .send_input(T::input(&conv, &format!("  {Q} "), &[], Some(&p.token)))
        .0
        .unwrap();
    assert_eq!(selection_ok.status, MessageStatus::Complete);
    assert_eq!(chat_requests(openai).len(), 1);
    assert_consent(t.send(&conv, Q, Some(&p.token)).0, Some(TOKEN_INVALID));
    assert_eq!(t.messages(), 2);
    assert_eq!(t.cloud.pending_count(), 0);

    // Expiry.
    let short = T::build(
        CloudPolicy::CloudAllowed,
        Some(Duration::from_millis(100)),
        None,
    );
    short.import("analisi.md", ANALISI);
    let conv = short.conversation();
    let p = short.prepare(&conv, Q).unwrap().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert_consent(short.send(&conv, Q, Some(&p.token)).0, Some(TOKEN_INVALID));
    assert_eq!(short.messages(), 0);
    assert_eq!(short.total_cloud_requests(), 0);
}

#[test]
fn sent_payload_is_exactly_the_preview() {
    let t = T::new(CloudPolicy::CloudAllowed);
    let doc = t.import("analisi.md", ANALISI);
    t.import("storia.md", STORIA);
    let conv = t.conversation();
    let (_, first) = t.ask_cloud(&conv, Q);
    assert_eq!(first.status, MessageStatus::Complete);

    let q2 = "Che cosa afferma il teorema di Rolle?";
    let p = t.prepare(&conv, q2).unwrap().unwrap();
    assert_eq!(p.question, q2);
    assert_eq!(p.history_pairs, 1);
    assert_eq!(
        p.history_chars,
        (Q.chars().count() + CLOUD_ANSWER.chars().count()) as u64
    );
    assert_eq!(p.sources[0].title, "analisi.md");
    assert_eq!(p.provider_name, "OpenAI");
    assert_eq!(p.host, "api.openai.com");
    assert_eq!(p.max_output_tokens, 2048);
    assert!(p.route.cloud);
    assert_eq!(p.route.reason, MANUAL_REASON);
    // The library changes after the preview: the confirmed request does not.
    t.store().delete_document(&doc.id).unwrap();
    t.import(
        "rolle.md",
        "Il teorema di Rolle è citato anche qui, con altre parole.",
    );
    let m = t.send(&conv, q2, Some(&p.token)).0.unwrap();
    assert_eq!(m.status, MessageStatus::Complete);

    let req = chat_requests(t.fake(CloudProvider::OpenAi))
        .pop()
        .unwrap()
        .json();
    let messages = req["messages"].as_array().unwrap();
    let total: u64 = messages
        .iter()
        .map(|m| m["content"].as_str().unwrap().chars().count() as u64)
        .sum();
    assert_eq!(
        total, p.total_chars,
        "characters sent == characters previewed"
    );
    assert_eq!(messages.len(), 1 + 2 * p.history_pairs as usize + 1);
    let last = messages.last().unwrap()["content"].as_str().unwrap();
    assert!(
        last.contains("Il teorema di Rolle afferma"),
        "passage of the deleted document"
    );
    assert!(
        !last.contains("altre parole"),
        "nothing added after the preview"
    );
    assert!(last.ends_with(&format!("Domanda: {q2}")));
    assert_eq!(messages[1]["content"], Q);
    assert_eq!(messages[2]["content"], CLOUD_ANSWER);
    assert_eq!(req["model"], "chat-fake");
    let numbered: Vec<u32> = m.sources.iter().filter_map(|s| s.n).collect();
    assert_eq!(numbered.len(), p.sources.len());
    assert_eq!(m.provider, Some(OPENAI));
    assert_eq!(m.model.as_deref(), Some("chat-fake"));
    assert_eq!(m.route_reason.as_deref(), Some(MANUAL_REASON));

    let log = t.store().list_cloud_requests(10).unwrap();
    let chat = &log[0];
    assert_eq!(chat.purpose, CloudPurpose::Chat);
    assert_eq!(chat.chars_sent, p.total_chars);
    assert_eq!(chat.conversation_id.as_deref(), Some(conv.as_str()));
    assert_eq!(chat.project_id.as_deref(), Some(t.project.as_str()));
    assert!(chat.ok && chat.error.is_none());
    assert_eq!(log.len(), 2);
    assert_eq!(t.store().list_cloud_requests(1).unwrap().len(), 1);
}

#[test]
fn turns_without_a_model_need_no_confirmation() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    for q in [
        "Quali documenti ho caricato?",
        "Parlami della fotosintesi clorofilliana",
    ] {
        assert!(t.prepare(&conv, q).unwrap().is_none(), "{q}");
        let m = t.send(&conv, q, None).0.unwrap();
        assert!(
            matches!(m.kind, MessageKind::Inventory | MessageKind::NoEvidence),
            "{q}"
        );
    }
    assert_eq!(t.total_cloud_requests(), 0);
}

// ------------------------------------------------------------------ failures

#[test]
fn provider_failures_never_fall_back() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    // Auto with two keyed cloud candidates (OpenAI cheaper): OpenAI is chosen and fails.
    t.settings(|s| {
        s.routing = Routing::Auto;
        s.auto_models = vec![
            cloud_model(CloudProvider::Anthropic),
            cloud_model(CloudProvider::OpenAi),
        ];
    });
    for (model, price) in [("chat-fake", 1.0), ("chat-fake", 5.0)] {
        let provider = if price == 1.0 {
            CloudProvider::OpenAi
        } else {
            CloudProvider::Anthropic
        };
        t.store()
            .set_price(&ModelPrice {
                provider,
                model: model.into(),
                input_per_mtok: price,
                output_per_mtok: price,
                currency: "USD".into(),
            })
            .unwrap();
    }
    let openai = t.fake(CloudProvider::OpenAi);
    for (status, message) in [
        (500, "OpenAI non raggiungibile."),
        (
            429,
            "Limite di richieste raggiunto per OpenAI. Riprova più tardi.",
        ),
        (401, "Chiave API non valida o senza permessi per OpenAI."),
        (400, "OpenAI ha rifiutato la richiesta."),
    ] {
        openai.set(|s| s.mode = Mode::Status(status));
        let (p, m) = t.ask_cloud(&conv, Q);
        assert_eq!(p.route.model, cloud_model(CloudProvider::OpenAi));
        assert_eq!(m.status, MessageStatus::Error, "{status}");
        let err = m.error.unwrap();
        assert_eq!(err.code, "llm_unavailable");
        assert_eq!(err.message, message);
        assert!(!err.detail.unwrap_or_default().contains(KEY));
        assert_eq!(m.provider, Some(OPENAI));
    }
    // Wrong key: the provider echoes it, Localis does not keep it.
    openai.set(|s| {
        s.mode = Mode::Normal;
        s.key = "a-different-key".into();
    });
    let (_, m) = t.ask_cloud(&conv, Q);
    assert_eq!(
        m.error.as_ref().unwrap().detail.as_deref(),
        Some("HTTP 401")
    );
    assert_eq!(
        chat_requests(t.fake(CloudProvider::Anthropic)).len(),
        0,
        "no fallback to Anthropic"
    );
    assert_eq!(
        t.lm.requests("/v1/chat/completions").len(),
        0,
        "no fallback to LM Studio"
    );
    let log = t.store().list_cloud_requests(100).unwrap();
    assert_eq!(log.len(), 5);
    assert!(log
        .iter()
        .all(|e| !e.ok && e.error.is_some() && e.purpose == CloudPurpose::Chat));
}

#[test]
fn cancelling_a_cloud_answer_keeps_the_partial_text_and_logs_it() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    t.fake(CloudProvider::OpenAi).set(|s| s.mode = Mode::Slow);
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    std::thread::scope(|scope| {
        let handle = scope.spawn(|| t.send(&conv, Q, Some(&p.token)).0.unwrap());
        wait_until("stream started", || {
            !chat_requests(t.fake(CloudProvider::OpenAi)).is_empty()
        });
        std::thread::sleep(Duration::from_millis(400));
        t.rt.cancel(&conv);
        let m = handle.join().unwrap();
        assert_eq!(m.status, MessageStatus::Cancelled);
        assert!(m.content.starts_with("parola"));
    });
    let log = t.store().list_cloud_requests(1).unwrap();
    assert_eq!(
        log[0].error.as_deref(),
        Some("Risposta interrotta dall'utente.")
    );
}

// ------------------------------------------------------------------ PRISM

#[test]
fn automatic_routing_prefers_local_then_cheapest_cloud() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    t.settings(|s| {
        s.routing = Routing::Auto;
        s.auto_models = vec![
            cloud_model(CloudProvider::OpenAi),
            ModelRef::lmstudio(CHAT_MODEL),
            cloud_model(CloudProvider::DeepSeek),
        ];
    });
    // LM Studio up: local wins, no confirmation, nothing to the cloud.
    assert!(t.prepare(&conv, Q).unwrap().is_none());
    let m = t.send(&conv, Q, None).0.unwrap();
    assert_eq!(m.provider, Some(ProviderId::LmStudio));
    assert_eq!(m.model.as_deref(), Some(CHAT_MODEL));
    assert!(m.route_reason.unwrap().contains("precedenza"));
    assert_eq!(t.total_cloud_requests(), 0);

    // LM Studio down: the cloud choice goes through the preview; no prices → list order.
    let up = t.lm.url.clone();
    t.settings(|s| s.base_url = closed_url());
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    assert_eq!(p.route.model, cloud_model(CloudProvider::OpenAi));
    assert!(
        p.route.reason.contains("LM Studio non è raggiungibile"),
        "{}",
        p.route.reason
    );
    // Prices: DeepSeek is cheaper.
    t.store()
        .set_price(&ModelPrice {
            provider: CloudProvider::DeepSeek,
            model: "chat-fake".into(),
            input_per_mtok: 0.1,
            output_per_mtok: 0.2,
            currency: "USD".into(),
        })
        .unwrap();
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    assert_eq!(p.route.model, cloud_model(CloudProvider::DeepSeek));
    assert!(p.route.reason.contains("più economico"));
    // LM Studio comes back before the confirmation: the choice changed, so the token
    // is no longer valid and nothing is sent.
    t.settings(|s| s.base_url = up);
    let before = t.messages();
    assert_consent(t.send(&conv, Q, Some(&p.token)).0, Some(ROUTE_CHANGED));
    assert_eq!(t.messages(), before);
    assert_eq!(chat_requests(t.fake(CloudProvider::DeepSeek)).len(), 0);
}

// ------------------------------------------------------------------ estimates and costs

#[test]
fn estimates_and_costs_follow_user_prices() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    // Without a price: no estimate, usage still reported, no cost.
    let (p, m) = t.ask_cloud(&conv, Q);
    assert!(p.est_cost.is_none());
    assert_eq!(p.est_input_tokens, p.total_chars.div_ceil(4));
    let usage = m.usage.unwrap();
    assert_eq!(
        (usage.input_tokens, usage.output_tokens),
        (Some(OPENAI_USAGE.0), Some(OPENAI_USAGE.1))
    );
    assert!(m.cost.is_none());

    t.store()
        .set_price(&ModelPrice {
            provider: CloudProvider::OpenAi,
            model: "chat-fake".into(),
            input_per_mtok: 2.0,
            output_per_mtok: 8.0,
            currency: "eur".into(),
        })
        .unwrap();
    let (p, m) = t.ask_cloud(&conv, Q);
    let (min, max) = p.est_cost.clone().unwrap();
    let est = p.est_input_tokens as f64;
    assert!((min.amount - est * 2.0 / 1e6).abs() < 1e-12);
    assert!((max.amount - (est * 2.0 + 2048.0 * 8.0) / 1e6).abs() < 1e-12);
    assert_eq!(min.currency, "EUR");
    let cost = m.cost.clone().unwrap();
    let expected = (OPENAI_USAGE.0 as f64 * 2.0 + OPENAI_USAGE.1 as f64 * 8.0) / 1e6;
    assert!((cost.amount - expected).abs() < 1e-12);
    assert_eq!(cost.currency, "EUR");
    // Stored and read back.
    let stored = t.store().list_messages(&conv).unwrap().pop().unwrap();
    assert_eq!(stored.cost, m.cost);
    assert_eq!(stored.usage, m.usage);
    let log = t.store().list_cloud_requests(1).unwrap();
    assert!((log[0].cost.as_ref().unwrap().amount - expected).abs() < 1e-12);
    assert_eq!(log[0].usage.unwrap().input_tokens, Some(OPENAI_USAGE.0));
}

// ------------------------------------------------------------------ providers

#[test]
fn every_provider_streams_with_usage_and_its_own_wire_format() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    for (p, path, usage) in [
        (CloudProvider::OpenAi, "/v1/chat/completions", OPENAI_USAGE),
        (CloudProvider::DeepSeek, "/chat/completions", OPENAI_USAGE),
        (
            CloudProvider::Qwen,
            "/compatible-mode/v1/chat/completions",
            OPENAI_USAGE,
        ),
        (CloudProvider::Anthropic, "/v1/messages", ANTHROPIC_USAGE),
        (
            CloudProvider::Gemini,
            "/v1beta/models/gemini-fake:streamGenerateContent?alt=sse",
            GEMINI_USAGE,
        ),
    ] {
        t.settings(|s| s.chat_model = Some(cloud_model(p)));
        let conv = t.conversation();
        let (preview, m) = t.ask_cloud(&conv, Q);
        assert_eq!(preview.host, p.host());
        assert_eq!(m.status, MessageStatus::Complete, "{p:?}: {:?}", m.error);
        assert_eq!(m.content, CLOUD_ANSWER, "{p:?}");
        assert_eq!(m.provider, Some(ProviderId::Cloud(p)));
        let u = m.usage.unwrap();
        assert_eq!(
            (u.input_tokens, u.output_tokens),
            (Some(usage.0), Some(usage.1)),
            "{p:?}"
        );
        assert!(m.sources.iter().any(|s| s.cited), "{p:?}: [1] is cited");
        let req = chat_requests(t.fake(p)).pop().unwrap();
        assert_eq!(req.path, path, "{p:?}");
        let body = req.json();
        match p {
            CloudProvider::Anthropic => {
                assert!(body["system"].as_str().unwrap().contains("Localis"));
                assert_eq!(body["max_tokens"], 2048);
                assert_eq!(body["messages"].as_array().unwrap().len(), 1);
            }
            CloudProvider::Gemini => {
                assert!(body["systemInstruction"]["parts"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("Localis"));
                assert_eq!(body["contents"][0]["role"], "user");
            }
            _ => {
                assert_eq!(body["stream_options"]["include_usage"], true);
                assert_eq!(body["messages"][0]["role"], "system");
            }
        }
        // OpenAI gets no temperature (reasoning models reject non-default values).
        let expected = if p == CloudProvider::OpenAi {
            None
        } else {
            Some(0.2)
        };
        assert_eq!(
            body["temperature"]
                .as_f64()
                .or(body["generationConfig"]["temperature"].as_f64()),
            expected
        );
    }
}

#[test]
fn model_lists_and_embeddings_per_provider() {
    let t = T::new(CloudPolicy::CloudAllowed);
    let client = |p| CloudClient::new(p, KEY.into(), t.cloud.endpoints().clone());
    let ids = |models: Vec<localis_core::ModelInfo>| -> Vec<(String, ModelKind)> {
        models.into_iter().map(|m| (m.id, m.kind)).collect()
    };
    assert_eq!(
        ids(client(CloudProvider::OpenAi).list_models().unwrap()),
        [
            ("chat-fake".into(), ModelKind::Unknown),
            ("text-embedding-fake".into(), ModelKind::Embedding)
        ]
    );
    assert_eq!(
        ids(client(CloudProvider::DeepSeek).list_models().unwrap()),
        [
            ("chat-fake".into(), ModelKind::Llm),
            ("text-embedding-fake".into(), ModelKind::Llm)
        ]
    );
    assert_eq!(client(CloudProvider::Qwen).list_models().unwrap().len(), 2);
    assert_eq!(
        ids(client(CloudProvider::Anthropic).list_models().unwrap()),
        [
            ("claude-a".into(), ModelKind::Llm),
            ("claude-b".into(), ModelKind::Llm),
            ("claude-c".into(), ModelKind::Llm)
        ]
    );
    assert_eq!(t.fake(CloudProvider::Anthropic).count(), 2, "paginated");
    assert_eq!(
        ids(client(CloudProvider::Gemini).list_models().unwrap()),
        [
            ("gemini-fake".into(), ModelKind::Llm),
            ("aqa".into(), ModelKind::Unknown),
            ("text-embedding-004".into(), ModelKind::Embedding)
        ]
    );
    let g = t.fake(CloudProvider::Gemini).requests();
    assert_eq!(g.len(), 2);
    assert_eq!(
        g[0].headers.get("x-goog-api-key").map(String::as_str),
        Some(KEY)
    );
    assert!(!g[0].path.contains(KEY), "the key never goes in the URL");

    // Embeddings.
    let texts: Vec<String> = ["derivata", "integrale", "Rolle"]
        .map(String::from)
        .to_vec();
    let (v, usage) = client(CloudProvider::Gemini)
        .embed("text-embedding-004", &texts, Duration::from_secs(10))
        .unwrap();
    assert_eq!(v.len(), 3);
    assert!(usage.is_empty());
    let req = t
        .fake(CloudProvider::Gemini)
        .matching("batchEmbedContents")
        .pop()
        .unwrap();
    assert_eq!(
        req.path,
        "/v1beta/models/text-embedding-004:batchEmbedContents"
    );
    assert_eq!(
        req.json()["requests"][0]["model"],
        "models/text-embedding-004"
    );
    let ten: Vec<String> = (0..10).map(|i| format!("testo {i}")).collect();
    let (v, usage) = client(CloudProvider::Qwen)
        .embed(EMBED, &ten, Duration::from_secs(10))
        .unwrap();
    assert_eq!(v.len(), 10);
    assert_eq!(usage.input_tokens, Some(EMBED_USAGE));
    for x in &v {
        let norm: f32 = x.iter().map(|a| a * a).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4);
    }
    let eleven: Vec<String> = (0..11).map(|i| format!("testo {i}")).collect();
    assert!(client(CloudProvider::Qwen)
        .embed(EMBED, &eleven, Duration::from_secs(10))
        .is_err());
    let err = client(CloudProvider::Anthropic)
        .embed("x", &texts, Duration::from_secs(10))
        .unwrap_err();
    assert_eq!(err.code(), "llm_unavailable");

    // 401 on listing: message by provider, no key in detail.
    t.fake(CloudProvider::DeepSeek)
        .set(|s| s.key = "other".into());
    let err = client(CloudProvider::DeepSeek).list_models().unwrap_err();
    assert_eq!(
        err.to_string(),
        "Chiave API non valida o senza permessi per DeepSeek."
    );
    assert!(!err.detail().unwrap().contains(KEY));
}

// ------------------------------------------------------------------ keys

#[test]
fn keys_never_reach_the_database_errors_or_events() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    t.settings(|s| s.embedding_model = Some(ModelRef::new(OPENAI, EMBED)));
    t.store()
        .set_cloud_embedding_consent(&t.project, true)
        .unwrap();
    let embedder = t.start_embedder(fast());
    wait_until("cloud indexing", || {
        let st = t
            .store()
            .embedding_status(&t.project, &embedder.shared)
            .unwrap();
        st.embedded == st.total && st.total > 0
    });
    let conv = t.conversation();
    let mut seen = String::new();
    // Success, provider errors (with the key echoed back by the fake), wrong key.
    for mode in [Mode::Normal, Mode::Status(429), Mode::Status(500)] {
        t.fake(CloudProvider::OpenAi).set(|s| s.mode = mode);
        let p = t.prepare(&conv, Q).unwrap().unwrap();
        seen.push_str(&format!("{p:?}"));
        let (r, events) = t.send(&conv, Q, Some(&p.token));
        seen.push_str(&format!("{r:?}{events:?}"));
    }
    t.fake(CloudProvider::OpenAi).set(|s| {
        s.mode = Mode::Normal;
        s.key = "other".into();
    });
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    let (r, events) = t.send(&conv, Q, Some(&p.token));
    seen.push_str(&format!("{r:?}{events:?}"));
    let err = CloudClient::new(
        CloudProvider::OpenAi,
        KEY.into(),
        t.cloud.endpoints().clone(),
    )
    .list_models()
    .unwrap_err();
    seen.push_str(&format!("{err:?} {err}"));
    seen.push_str(&format!("{:?}", t.cloud.env));
    seen.push_str(&format!(
        "{:?}",
        t.store().list_cloud_requests(1000).unwrap()
    ));
    seen.push_str(&format!("{:?}", t.store().list_messages(&conv).unwrap()));
    seen.push_str(&format!("{:?}", embedder.shared.snapshot()));
    drop(embedder);
    assert!(seen.contains("Limite di richieste"), "the flows ran");
    assert!(!seen.contains(KEY), "key leaked into errors/events/logs");
    assert!(!seen.contains("SENTINEL"));
    // Every file of the database (main, WAL, shared memory).
    drop(t.store());
    let mut checked = 0;
    for entry in std::fs::read_dir(t.dir.path()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let bytes = std::fs::read(&path).unwrap();
            assert!(
                !bytes.windows(KEY.len()).any(|w| w == KEY.as_bytes()),
                "key found in {}",
                path.display()
            );
            assert!(
                !bytes.windows(8).any(|w| w == b"SENTINEL"),
                "{}",
                path.display()
            );
            checked += 1;
        }
    }
    assert!(checked >= 1);
    // But the request did carry it, in the header only.
    let req = t.fake(CloudProvider::OpenAi).requests().pop().unwrap();
    assert_eq!(req.headers["authorization"], format!("Bearer {KEY}"));
    assert!(!req.body.contains(KEY));
}

#[test]
fn unavailable_keychain_is_reported_without_fallback() {
    let t = T::build(
        CloudPolicy::CloudAllowed,
        None,
        Some(Arc::new(UnavailableKeys)),
    );
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    let err = t.prepare(&conv, Q).unwrap_err();
    assert_eq!(err.code(), "keyring_unavailable");
    assert!(err.to_string().contains("portachiavi"));
    assert!(!t.cloud.keys().status().available);
    let err = CloudClient::from_keys(CloudProvider::OpenAi, t.cloud.keys(), t.cloud.endpoints())
        .unwrap_err();
    assert_eq!(err.code(), "keyring_unavailable");
    // Automatic routing treats the providers as keyless.
    t.settings(|s| {
        s.routing = Routing::Auto;
        s.auto_models = vec![cloud_model(CloudProvider::OpenAi)];
    });
    assert!(t.prepare(&conv, Q).unwrap().is_none());
    let m = t.send(&conv, Q, None).0.unwrap();
    assert!(m.error.unwrap().message.contains("chiave API"));
    assert_eq!(t.total_cloud_requests(), 0);
}

#[test]
fn missing_key_is_reported_before_any_request() {
    let keys = Arc::new(MemoryKeys::default());
    let t = T::build(CloudPolicy::CloudAllowed, None, Some(keys.clone()));
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    let err = t.prepare(&conv, Q).unwrap_err();
    assert_eq!(err.code(), "llm_unavailable");
    assert!(err
        .to_string()
        .starts_with("Nessuna chiave API salvata per OpenAI"));
    keys.set(CloudProvider::OpenAi, KEY).unwrap();
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    // The key removed between preview and confirmation: clear error, nothing sent.
    keys.delete(CloudProvider::OpenAi).unwrap();
    let m = t.send(&conv, Q, Some(&p.token)).0.unwrap();
    assert_eq!(m.status, MessageStatus::Error);
    assert!(m.error.unwrap().message.starts_with("Nessuna chiave API"));
    assert_eq!(t.total_cloud_requests(), 0);
}

// ------------------------------------------------------------------ cloud embeddings

#[test]
fn cloud_embedder_indexes_only_consenting_projects_and_stops_on_revoke() {
    let t = T::new(CloudPolicy::CloudAllowed);
    let a = t.project.clone();
    let b = t.new_project("Senza consenso", CloudPolicy::CloudAllowed);
    let c = t.new_project("Locale", CloudPolicy::LocalOnly);
    t.import_into(&a, "analisi.md", ANALISI.as_bytes());
    t.import_into(&b, "storia.md", STORIA.as_bytes());
    t.import_into(&c, "chimica.md", CHIMICA.as_bytes());
    t.settings(|s| s.embedding_model = Some(ModelRef::new(OPENAI, EMBED)));

    // Estimate before consent.
    let est = t.store().estimate_cloud_embedding(&a).unwrap().unwrap();
    let (total, _) = t.store().embedding_counts(&a, None).unwrap();
    assert_eq!(est.chunks, total);
    assert_eq!(
        est.chars,
        ANALISI
            .split("\n\n")
            .map(|p| p.chars().count() as u64)
            .sum::<u64>()
    );
    assert_eq!(est.est_tokens, est.chars.div_ceil(4));
    assert!(est.est_cost.is_none());
    t.store()
        .set_price(&ModelPrice {
            provider: CloudProvider::OpenAi,
            model: EMBED.into(),
            input_per_mtok: 0.02,
            output_per_mtok: 0.0,
            currency: "USD".into(),
        })
        .unwrap();
    let est = t.store().estimate_cloud_embedding(&a).unwrap().unwrap();
    assert!((est.est_cost.unwrap().amount - est.est_tokens as f64 * 0.02 / 1e6).abs() < 1e-15);

    let embedder = t.start_embedder(fast());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        t.fake(CloudProvider::OpenAi).count(),
        0,
        "nothing without consent"
    );
    t.store().set_cloud_embedding_consent(&a, true).unwrap();
    embedder.wake();
    wait_until("project A indexed", || {
        let st = t.store().embedding_status(&a, &embedder.shared).unwrap();
        st.state == EmbeddingState::Idle && st.embedded == st.total
    });
    std::thread::sleep(Duration::from_millis(200));
    let sent: String = t
        .fake(CloudProvider::OpenAi)
        .matching("/embeddings")
        .iter()
        .map(|r| r.body.clone())
        .collect();
    assert!(sent.contains("derivata"));
    assert!(
        !sent.contains("Bastiglia") && !sent.contains("periodica"),
        "only project A"
    );
    for p in [&b, &c] {
        let st = t.store().embedding_status(p, &embedder.shared).unwrap();
        assert_eq!(st.state, EmbeddingState::NeedsConsent);
        assert_eq!(st.embedded, 0);
    }
    let log = t.store().list_cloud_requests(100).unwrap();
    assert!(!log.is_empty());
    assert!(log.iter().all(|e| e.purpose == CloudPurpose::IndexEmbedding
        && e.project_id.as_deref() == Some(a.as_str())
        && e.ok
        && e.usage.unwrap().input_tokens == Some(EMBED_USAGE)));
    assert_eq!(
        t.store()
            .estimate_cloud_embedding(&a)
            .unwrap()
            .unwrap()
            .chunks,
        0
    );

    // The question's embedding goes to the cloud for this project, and the preview says so.
    let conv = t.conversation();
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    assert_eq!(p.query_embedded_by, Some(ModelRef::new(OPENAI, EMBED)));
    let m = t.send(&conv, Q, Some(&p.token)).0.unwrap();
    let r = m.retrieval.unwrap();
    assert_eq!(r.mode, RetrievalMode::Hybrid);
    assert_eq!(r.embedding_provider, Some(OPENAI));
    assert_eq!(r.embedding_model.as_deref(), Some(EMBED));
    let log = t.store().list_cloud_requests(100).unwrap();
    let q = log
        .iter()
        .find(|e| e.purpose == CloudPurpose::QueryEmbedding)
        .unwrap();
    assert_eq!(q.chars_sent, Q.chars().count() as u64);
    assert_eq!(q.conversation_id.as_deref(), Some(conv.as_str()));

    // Revocation: no more indexing, no more query embeddings for the project.
    t.store().set_cloud_embedding_consent(&a, false).unwrap();
    embedder.wake();
    let before = t.fake(CloudProvider::OpenAi).matching("/embeddings").len();
    t.import_into(
        &a,
        "rolle.md",
        "Il teorema di Rolle riguarda le funzioni derivabili.".as_bytes(),
    );
    embedder.wake();
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        t.fake(CloudProvider::OpenAi).matching("/embeddings").len(),
        before
    );
    let st = t.store().embedding_status(&a, &embedder.shared).unwrap();
    assert_eq!(st.state, EmbeddingState::NeedsConsent);
    let p = t.prepare(&conv, Q).unwrap().unwrap();
    assert_eq!(p.query_embedded_by, None);
    assert_eq!(
        t.fake(CloudProvider::OpenAi).matching("/embeddings").len(),
        before
    );
    t.cloud.discard(&p.token);

    // Making the project local-only also revokes the consent.
    t.store().set_cloud_embedding_consent(&a, true).unwrap();
    let project = t
        .store()
        .set_project_cloud_policy(&a, CloudPolicy::LocalOnly)
        .unwrap();
    assert!(!project.cloud_embedding_consent);
    drop(embedder);

    // Local embedding model: no cloud estimate.
    t.settings(|s| s.embedding_model = Some(ModelRef::lmstudio("fake-embed")));
    assert!(t.store().estimate_cloud_embedding(&a).unwrap().is_none());
}

#[test]
fn cloud_embedder_backs_off_on_rate_limit() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    t.settings(|s| {
        s.embedding_model = Some(ModelRef::new(
            ProviderId::Cloud(CloudProvider::Gemini),
            "text-embedding-004",
        ))
    });
    t.store()
        .set_cloud_embedding_consent(&t.project, true)
        .unwrap();
    let gemini = t.fake(CloudProvider::Gemini);
    gemini.set(|s| s.embed_mode = Mode::Status(429));
    let embedder = t.start_embedder(fast());
    wait_until("rate limit reported", || {
        let st = t
            .store()
            .embedding_status(&t.project, &embedder.shared)
            .unwrap();
        st.state == EmbeddingState::Unreachable
            && st
                .message
                .as_deref()
                .is_some_and(|m| m.contains("Limite di richieste"))
    });
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(gemini.count(), 1, "backs off instead of retrying at once");
    let snap = embedder.shared.snapshot();
    assert_eq!(snap.retry_in, Some(Duration::from_secs(30)));
    assert!(!snap.detail.unwrap_or_default().contains(KEY));
    let log = t.store().list_cloud_requests(10).unwrap();
    assert_eq!(log.len(), 1);
    assert!(!log[0].ok);
    // Recovery after a wake (e.g. the user retried / changed settings).
    gemini.set(|s| s.embed_mode = Mode::Normal);
    embedder.wake();
    wait_until("indexed after recovery", || {
        let st = t
            .store()
            .embedding_status(&t.project, &embedder.shared)
            .unwrap();
        st.embedded == st.total
    });
}

// ------------------------------------------------------------------ migration 3 → 4

#[test]
fn migration_3_to_4_keeps_settings_embeddings_and_messages() {
    let mut env = Env::new();
    let p = env.project("Tesi").id;
    env.import(&p, "analisi.md", ANALISI.as_bytes());
    env.run_jobs();
    let conv = env.store.create_conversation(&p).unwrap().id;
    let chunks: i64 = env.count("SELECT COUNT(*) FROM chunks");
    drop(std::mem::replace(
        &mut env.store,
        Store::open_in_memory().unwrap(),
    ));
    // Shape the database as v0.3 left it: plain-string model settings, embeddings keyed by
    // model id, messages without the v0.4 columns, no v0.4 tables.
    {
        let conn = env.raw();
        conn.execute_batch(&format!(
            "INSERT INTO settings VALUES ('llm.base_url', 'http://127.0.0.1:1234');
             INSERT INTO settings VALUES ('llm.chat_model', 'qwen2.5-7b-instruct');
             INSERT INTO settings VALUES ('llm.embedding_model', 'nomic-embed-text');
             INSERT INTO chunk_embeddings (chunk_id, model, dim, vector)
                 SELECT id, 'nomic-embed-text', 1, x'0000803f' FROM chunks;
             INSERT INTO messages (id, conversation_id, seq, role, kind, content, status, model,
                 retrieval_mode, embedding_model, created_at, updated_at)
             VALUES ('m1', '{conv}', 1, 'user', 'question', 'Domanda?', 'complete', NULL,
                     NULL, NULL, 'c', 'c'),
                    ('m2', '{conv}', 2, 'assistant', 'answer', 'Risposta [1].', 'complete',
                     'qwen2.5-7b-instruct', 'hybrid', 'nomic-embed-text', 'c', 'c');
             DROP TABLE cloud_requests; DROP TABLE model_prices;
             ALTER TABLE projects DROP COLUMN cloud_policy;
             ALTER TABLE projects DROP COLUMN cloud_embedding_consent;
             ALTER TABLE messages DROP COLUMN provider;
             ALTER TABLE messages DROP COLUMN route_reason;
             ALTER TABLE messages DROP COLUMN input_tokens;
             ALTER TABLE messages DROP COLUMN output_tokens;
             ALTER TABLE messages DROP COLUMN cost_amount;
             ALTER TABLE messages DROP COLUMN cost_currency;
             ALTER TABLE messages DROP COLUMN embedding_provider;
             PRAGMA user_version = 3;"
        ))
        .unwrap();
    }
    let store = env.reopen();
    assert_eq!(store.schema_version().unwrap(), 4);
    let s = store.llm_settings().unwrap();
    assert_eq!(
        s.chat_model,
        Some(ModelRef::lmstudio("qwen2.5-7b-instruct"))
    );
    assert_eq!(
        s.embedding_model,
        Some(ModelRef::lmstudio("nomic-embed-text"))
    );
    assert_eq!(s.routing, Routing::Manual);
    assert!(s.auto_models.is_empty());
    assert_eq!(s.base_url, "http://127.0.0.1:1234");
    assert_eq!(
        env.count(
            "SELECT COUNT(*) FROM chunk_embeddings WHERE model = 'lmstudio:nomic-embed-text'"
        ),
        chunks
    );
    let shared = EmbedderShared::new();
    let st = store.embedding_status(&p, &shared).unwrap();
    assert_eq!((st.embedded, st.total), (chunks as u64, chunks as u64));
    assert_eq!(st.provider, Some(ProviderId::LmStudio));
    let project = store.get_project(&p).unwrap();
    assert_eq!(project.cloud_policy, CloudPolicy::LocalOnly);
    assert!(!project.cloud_embedding_consent);
    let msgs = store.list_messages(&conv).unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[1].content, "Risposta [1].");
    assert_eq!(msgs[1].provider, Some(ProviderId::LmStudio));
    assert_eq!(msgs[1].model.as_deref(), Some("qwen2.5-7b-instruct"));
    assert_eq!(
        msgs[1].retrieval.as_ref().unwrap().embedding_provider,
        Some(ProviderId::LmStudio)
    );
    assert_eq!(msgs[0].provider, None);
    assert!(msgs[1].usage.is_none() && msgs[1].cost.is_none() && msgs[1].route_reason.is_none());
    assert!(store.list_prices().unwrap().is_empty());
    assert!(store.list_cloud_requests(10).unwrap().is_empty());
    // New projects are local-only by default.
    drop(store);
    let mut store = env.reopen();
    let q = store
        .create_project(NewProject {
            name: "Nuovo".into(),
            description: None,
        })
        .unwrap();
    assert_eq!(q.cloud_policy, CloudPolicy::LocalOnly);
}

#[test]
fn deleting_a_project_keeps_the_log_without_references() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    let conv = t.conversation();
    t.ask_cloud(&conv, Q);
    t.store().delete_project(&t.project).unwrap();
    let log = t.store().list_cloud_requests(10).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].project_id, None);
    assert_eq!(log[0].conversation_id, None);
}

#[test]
fn listing_models_sends_only_the_key_on_request_and_is_logged() {
    let keys = Arc::new(MemoryKeys::with(&[(CloudProvider::Gemini, KEY)]));
    let t = T::build(CloudPolicy::LocalOnly, None, Some(keys));
    // No key: nothing sent, nothing logged.
    let m = list_provider_models(&t.db, &t.cloud, CloudProvider::OpenAi).unwrap();
    assert!(!m.reachable);
    assert!(m
        .message
        .unwrap()
        .starts_with("Nessuna chiave API salvata per OpenAI"));
    assert_eq!(t.total_cloud_requests(), 0);
    assert!(t.store().list_cloud_requests(10).unwrap().is_empty());
    let m = list_provider_models(&t.db, &t.cloud, CloudProvider::Gemini).unwrap();
    assert!(m.reachable);
    assert_eq!(m.models.len(), 3);
    for r in t.fake(CloudProvider::Gemini).requests() {
        assert_eq!(r.method, "GET");
        assert!(r.body.is_empty(), "only the key (in a header) is sent");
    }
    t.fake(CloudProvider::Gemini)
        .set(|s| s.mode = Mode::Status(503));
    let m = list_provider_models(&t.db, &t.cloud, CloudProvider::Gemini).unwrap();
    assert!(!m.reachable);
    assert_eq!(
        m.message.as_deref(),
        Some("Google Gemini non raggiungibile.")
    );
    assert!(!m.detail.unwrap().contains(KEY));
    let log = t.store().list_cloud_requests(10).unwrap();
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|e| e.purpose == CloudPurpose::ListModels
        && e.chars_sent == 0
        && e.project_id.is_none()));
    assert!(!log[0].ok && log[1].ok);
}

#[test]
fn unconfirmed_cloud_send_contacts_no_provider_at_all() {
    let t = T::new(CloudPolicy::CloudAllowed);
    t.import("analisi.md", ANALISI);
    t.settings(|s| {
        s.embedding_model = Some(ModelRef::new(OPENAI, EMBED));
        s.chat_model = Some(cloud_model(CloudProvider::OpenAi));
    });
    t.store()
        .set_cloud_embedding_consent(&t.project, true)
        .unwrap();
    let embedder = t.start_embedder(fast());
    embedder.wake();
    wait_until("indexed", || {
        let st = t
            .store()
            .embedding_status(&t.project, &embedder.shared)
            .unwrap();
        st.state == EmbeddingState::Idle && st.embedded == st.total && st.total > 0
    });
    drop(embedder);
    std::thread::sleep(Duration::from_millis(200));
    let before = t.fake(CloudProvider::OpenAi).count();

    // A question that needs the model, sent without confirmation: refused before any
    // network call — not even the query embedding goes out.
    let conv = t.conversation();
    let (r, _) = t.send(&conv, "Che cos'è la derivata di una funzione?", None);
    assert_consent(r, None);
    assert_eq!(t.fake(CloudProvider::OpenAi).count(), before);
}
