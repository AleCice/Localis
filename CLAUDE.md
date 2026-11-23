# Localis — note per agenti

App desktop local-first per studio e ricerca (Tauri v2 + Rust + SQLite, React + TypeScript + Vite).
Visione e versioni: `docs/ROADMAP.md`. Stato verificato: `docs/STATUS.md`.

## Struttura
- `crates/localis-core/` — dominio e SQLite (rusqlite bundled). Nessuna dipendenza da Tauri: si testa senza librerie GUI.
- `src-tauri/` — app Tauri: comandi sottili che delegano al core e mappano gli errori. Config, capabilities e `build.rs` limitano i comandi esposti.
- `src/api/` — unico punto che chiama `invoke()`; `types.ts` è il contratto con il backend. `mock.ts` è solo per `npm run dev:mock` e test nel browser.
- `src/` — UI React. Preferenze UI in `localStorage` (chiavi `localis.*`), dati dei progetti solo in SQLite.

## Contratto
Fonte di verità: `src/api/types.ts` + `src/api/client.ts` (nomi comandi, argomenti, forme JSON).
- 0.1 progetti: `list_projects`, `create_project({input})`, `delete_project({id})`.
- 0.5 FARO: import a blocchi (`begin_upload`, `upload_chunk`, `finish_upload`, `cancel_upload`), riproduzione via protocollo `localis-media` (Range), modelli Whisper (`list/download/cancel/delete_whisper_model`), `start_transcription`, `cancel_job`, `get_transcript`, collegamenti (`list_media_links`, `list_links_for_target`, `create/update/delete_media_link`).
- 0.4 cloud: chiavi (`get_keyring_status`, `list_providers`, `set/delete_api_key`), `list_provider_models`, prezzi (`list/set/delete_price`), progetto (`set_project_cloud_policy`, `estimate_cloud_embedding`, `set_cloud_embedding_consent`), invio (`prepare_cloud_send` → `send_message` con `confirmToken`, `discard_cloud_send`), `list_cloud_requests`.
- 0.3 chat: impostazioni LM Studio (`get/set_llm_settings`, `get_llm_status`, `get_embedding_status`), conversazioni (`list/create/delete_conversation`, `list_messages`), `send_message` (eventi su Channel), `cancel_generation`.
- 0.2 libreria: cartelle (`list/create/rename/delete_folder`), documenti (`list_documents`, `list_versions`, `import_document`, `import_version`, `move_document`, `delete_document`, `read_original`, `get_text`), `search`, job (`list_jobs`, `retry_job`).
- Import: la webview invia i **byte** del file scelto dall'utente (corpo IPC raw + header); il backend non legge mai percorsi arbitrari.
- Ogni nuovo comando va aggiunto anche in `src-tauri/build.rs` e `src-tauri/capabilities/default.json`.
Errori: `{ code: validation|duplicate|not_found|conflict|unsupported|too_large|integrity|llm_unavailable|cancelled|consent_required|keyring_unavailable|storage|internal, message (italiano, per la UI), field?, detail? (diagnostica) }`.
Serializzazione camelCase. ID UUID v4, date ISO 8601 UTC.

## Comandi
- `npm run typecheck` · `npm test` · `npm run build` · `npm run dev:mock` (UI nel browser con backend finto in memoria)
- `cargo fmt --all --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace`
- `npm run tauri dev` · `npm run tauri build -- --debug`

## Vincoli
- Solo ciò che serve alla versione corrente: niente tabelle, dipendenze o astrazioni per versioni future.
- Nessuna funzione finta, nessuna telemetria. Rete solo dal backend: LM Studio su loopback e, dalla 0.4, i cinque provider cloud su host fissi, solo per progetti `cloud_allowed` e solo dopo conferma esplicita (chat: a ogni domanda; embedding: consenso per progetto). Nessun fallback silenzioso al cloud. Dalla 0.5, download dei modelli Whisper da huggingface.co solo su comando esplicito dell'utente, verificati con SHA-256. Nessuna richiesta di rete dalla webview. Query sempre parametrizzate.
- API key solo nel portachiavi di sistema (`keyring`): mai nel DB, nei log, negli errori, negli eventi o nel repository; nessun ripiego in chiaro.
- Originali copiati in `<app_data>/originals/` (content-addressed per sha256); testo estratto e indice FTS solo nel DB. Le cancellazioni rimuovono record e copie di Localis non più referenziate, mai file dell'utente.
- Mai dichiarare testo ricercabile che non esiste (PDF scansiti = `no_text`, niente OCR prima della 0.6).
- UI e documentazione in italiano; codice, identificatori e commit in inglese.
- Test solo con fixture sintetiche e directory temporanee. Mai database o segreti in Git.
