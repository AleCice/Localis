# Stato di Localis

**Versione corrente: 0.1 — Fondazioni.** Stato: completata e verificata su Linux (container headless). Non verificata su macOS e Windows.

Ultimo aggiornamento: 18 novembre 2026.

## Piano 0.1 (seguito)

1. Bootstrap: workspace Cargo (`crates/localis-core` + `src-tauri`), Vite + React + TypeScript, Tauri v2, lockfile.
2. Contratto frontend ↔ backend fissato in `src/api/types.ts` prima del lavoro in parallelo.
3. Backend: SQLite con migrazioni versionate, validazione, tre comandi Tauri, errori strutturati, test su DB temporanei.
4. Frontend: shell con sidebar, onboarding, progetti (elenco, dettaglio, creazione, eliminazione), impostazioni tema, stati vuoto/caricamento/errore.
5. Integrazione, verifiche automatiche, build nativa, QA indipendente con E2E sull'app vera, correzioni.

## Criteri di accettazione

| # | Criterio | Stato | Evidenza |
|---|---|---|---|
| 1 | L'app si avvia seguendo il README | ✅ Linux | Prerequisiti installati come da README; `npm ci`, `npm run tauri build -- --debug --no-bundle` riuscito; il binario parte sotto Xvfb (E2E). `npm run tauri dev` non provato con display reale. |
| 2 | Primo avvio: creo un progetto senza servizi esterni | ✅ | E2E nativo: onboarding → «Crea il primo progetto» → progetto creato e selezionato. Nessuna rete a runtime (CSP `connect-src` limitata all'IPC, verificato che `fetch` esterno è bloccato). |
| 3 | Nome vuoto rifiutato con messaggio chiaro | ✅ | E2E nativo: nome vuoto e solo spazi → «Inserisci un nome.» accanto al campo, focus sul campo; duplicato con maiuscole diverse rifiutato dal backend reale. Lunghezza massima coperta da test Rust e Vitest. |
| 4 | Dopo il riavvio ritrovo progetto e tema | ✅ | E2E nativo: chiusura e riapertura con la stessa directory dati → progetto presente, onboarding non mostrato, tema scuro applicato. |
| 5 | Annulla senza effetti; conferma elimina in modo permanente | ✅ | E2E nativo: Annulla ed Esc lasciano il progetto; conferma lo rimuove; dopo il riavvio resta eliminato. |
| 6 | Controlli principali da tastiera con focus visibile | ✅ | Playwright (UI con backend finto) e WebDriver sulla webview nativa: ordine di tabulazione logico, anello di focus visibile, dialoghi con focus intrappolato, Esc e ritorno del focus, elenco navigabile con frecce/Home/Fine. |
| 7 | Nessun overflow orizzontale, controlli raggiungibili | ✅ con riserva | Nessun overflow a 480, 720, 1280, 1920 px e a zoom 200% (anche 480 px al 200%, dopo correzione). Finestra nativa a 480×400, 720×600, 1920×1080. Massimizzazione e fullscreen reali non provati: Xvfb non ha window manager. |
| 8 | Test automatici su DB di test | ✅ | `crates/localis-core/tests/store.rs` (16 test): migrazione da zero, riapertura senza perdite né duplicati, DB più recente rifiutato, creazione, validazione, duplicati, persistenza, cancellazione, `not_found`. |

## Verifiche eseguite (ultima esecuzione)

| Comando | Esito |
|---|---|
| `npm run typecheck` | ok |
| `npm test` | 21/21 test passati |
| `npm run build` | ok (il codice del backend finto non entra nel bundle) |
| `cargo fmt --all --check` | ok |
| `cargo clippy --workspace --all-targets -- -D warnings` | ok, nessun warning |
| `cargo test --workspace` | 33/33 passati: 8 nell'app Tauri, 9 unitari e 16 di integrazione nel core |
| `npm run tauri build -- --debug --no-bundle` | ok |
| `node e2e/native.mjs` (app nativa, SQLite reale, Xvfb + tauri-driver) | 39/39 controlli passati |
| Playwright su `npm run dev:mock` (tastiera, focus, layout, zoom, reduced motion) | 32/32 controlli passati; script del QA non incluso nel repository |

Non eseguito: `npm run tauri build` di release con installer, avvio su macOS e Windows, prova con screen reader.

## Decisioni

- **Core separato da Tauri** (`crates/localis-core`): dominio e SQLite si testano senza librerie grafiche.
- **SQLite tramite `rusqlite` con `bundled`**: nessuna dipendenza dalla versione di SQLite di sistema. Migrazioni in un elenco statico tracciato con `PRAGMA user_version`, ciascuna in una transazione; un database creato da una versione più recente viene rifiutato senza modifiche.
- **Unicità del nome** controllata nel core con confronto Unicode case-insensitive dopo il trim, più un indice `NOCASE` come rete di sicurezza.
- **Firma di `create_project`**: il comando riceve `{ input: { name, description? } }` invece dei campi al primo livello indicati nel prompt; il contratto è coerente in `src/api/types.ts`, `client.ts` e `commands.rs`.
- **Apertura del database pigra con nuovo tentativo**: se all'avvio il database non si apre, l'app parte comunque e mostra l'errore; ogni comando successivo (anche «Riprova») ritenta l'apertura.
- **Permessi minimi**: `build.rs` genera permessi solo per i tre comandi e la capability li abilita soltanto per la finestra principale; nessun plugin Tauri. CSP restrittiva verificata nell'E2E.
- **Preferenze UI in `localStorage`** (`localis.theme`, `localis.sidebar`, `localis.onboarded`), con accessi protetti; i progetti solo in SQLite.
- **Backend finto in memoria** (`src/api/mock.ts`) solo per `npm run dev:mock` e test nel browser; non entra nella build di produzione.

## Limiti noti

- La sidebar in sovrapposizione nelle finestre strette non è modale: Tab raggiunge il contenuto dietro lo sfondo scuro. Esc, clic sullo sfondo o navigazione la chiudono.
- La vista corrente non viene ricordata: l'app riapre sempre su Progetti.
- Un cambio di tema fatto un istante prima di una chiusura forzata potrebbe non essere salvato, perché la webview scrive `localStorage` in modo asincrono. Non verificato.
- Lo stato sincronizzato con il tema di sistema è verificato solo nei test Vitest e nel browser, non nella webview nativa.

## Come verificare ciò che qui non è stato provato

Su macOS o Windows, o su Linux con display:

1. Installa i prerequisiti e avvia con `npm run tauri dev` (vedi README).
2. Crea un progetto dall'onboarding, prova un nome vuoto, scegli il tema Scuro.
3. Chiudi e riapri: progetto e tema devono esserci.
4. Elimina: Annulla non cambia nulla; Elimina lo rimuove; riapri e controlla che non ricompaia.
5. Massimizza e metti a schermo intero; poi riduci la finestra al minimo (480×400): nessuno scorrimento orizzontale, sidebar richiudibile.

## Prossimo passo: 0.2 — Libreria documenti

Primo lavoro: decidere e documentare il modello di archiviazione (copia degli originali nello storage dell'app oppure riferimenti ai file esterni), con migrazione 2 per documenti e versioni con hash, e import di file TXT e Markdown come primo formato. Poi PDF, DOCX, immagini, FTS5 e job queue. Vedi `docs/ROADMAP.md`.
