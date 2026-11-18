# Localis — note per agenti

App desktop local-first per studio e ricerca (Tauri v2 + Rust + SQLite, React + TypeScript + Vite).
Visione e versioni: `docs/ROADMAP.md`. Stato verificato: `docs/STATUS.md`.

## Struttura
- `crates/localis-core/` — dominio e SQLite (rusqlite bundled). Nessuna dipendenza da Tauri: si testa senza librerie GUI.
- `src-tauri/` — app Tauri: comandi sottili che delegano al core e mappano gli errori. Config, capabilities e `build.rs` limitano i comandi esposti.
- `src/api/` — unico punto che chiama `invoke()`; `types.ts` è il contratto con il backend. `mock.ts` è solo per `npm run dev:mock` e test nel browser.
- `src/` — UI React. Preferenze UI in `localStorage` (chiavi `localis.*`), dati dei progetti solo in SQLite.

## Contratto (0.1)
`list_projects() -> Project[]`, `create_project({input:{name, description?}}) -> Project`, `delete_project({id}) -> void`.
Errori: `{ code: validation|duplicate|not_found|storage|internal, message (italiano, per la UI), field?, detail? (diagnostica) }`.
Serializzazione camelCase. ID UUID v4, date ISO 8601 UTC.

## Comandi
- `npm run typecheck` · `npm test` · `npm run build` · `npm run dev:mock` (UI nel browser con backend finto in memoria)
- `cargo fmt --all --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace`
- `npm run tauri dev` · `npm run tauri build -- --debug`

## Vincoli
- Solo ciò che serve alla versione corrente: niente tabelle, dipendenze o astrazioni per versioni future.
- Nessuna funzione finta, nessuna rete a runtime, nessuna telemetria. Query sempre parametrizzate.
- Eliminare un progetto cancella solo il record: mai file dell'utente.
- UI e documentazione in italiano; codice, identificatori e commit in inglese.
- Test solo con fixture sintetiche e directory temporanee. Mai database o segreti in Git.
