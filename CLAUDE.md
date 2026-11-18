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
- 0.2 libreria: cartelle (`list/create/rename/delete_folder`), documenti (`list_documents`, `list_versions`, `import_document`, `import_version`, `move_document`, `delete_document`, `read_original`, `get_text`), `search`, job (`list_jobs`, `retry_job`).
- Import: la webview invia i **byte** del file scelto dall'utente (corpo IPC raw + header); il backend non legge mai percorsi arbitrari.
- Ogni nuovo comando va aggiunto anche in `src-tauri/build.rs` e `src-tauri/capabilities/default.json`.
Errori: `{ code: validation|duplicate|not_found|conflict|unsupported|too_large|integrity|storage|internal, message (italiano, per la UI), field?, detail? (diagnostica) }`.
Serializzazione camelCase. ID UUID v4, date ISO 8601 UTC.

## Comandi
- `npm run typecheck` · `npm test` · `npm run build` · `npm run dev:mock` (UI nel browser con backend finto in memoria)
- `cargo fmt --all --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace`
- `npm run tauri dev` · `npm run tauri build -- --debug`

## Vincoli
- Solo ciò che serve alla versione corrente: niente tabelle, dipendenze o astrazioni per versioni future.
- Nessuna funzione finta, nessuna rete a runtime, nessuna telemetria. Query sempre parametrizzate.
- Originali copiati in `<app_data>/originals/` (content-addressed per sha256); testo estratto e indice FTS solo nel DB. Le cancellazioni rimuovono record e copie di Localis non più referenziate, mai file dell'utente.
- Mai dichiarare testo ricercabile che non esiste (PDF scansiti = `no_text`, niente OCR prima della 0.5).
- UI e documentazione in italiano; codice, identificatori e commit in inglese.
- Test solo con fixture sintetiche e directory temporanee. Mai database o segreti in Git.
