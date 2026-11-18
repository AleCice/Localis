# Localis

App desktop local-first per studio e ricerca. Ogni **progetto** è un contenitore libero (un corso, una tesi, una ricerca) in cui, nelle prossime versioni, raccoglierai documenti e lezioni, farai domande con citazioni verificabili e produrrai materiali di studio collegati alle fonti.

**Versione 0.1 — Fondazioni.** Oggi Localis permette di creare, ritrovare dopo il riavvio ed eliminare progetti, con onboarding, tema chiaro/scuro e una shell con navigazione. Libreria e Chat compaiono nella navigazione ma non sono ancora disponibili. Visione e versioni: [`docs/ROADMAP.md`](docs/ROADMAP.md). Stato verificato: [`docs/STATUS.md`](docs/STATUS.md).

Tutti i dati restano sul tuo computer. Nessun account, nessun servizio esterno, nessuna telemetria.

## Prerequisiti

- **Node.js** 22 o successivo, con npm.
- **Rust** stabile 1.90 o successivo (`rustup`), con `rustfmt` e `clippy` per le verifiche.
- **Prerequisiti di sistema di Tauri v2** per la tua piattaforma: <https://v2.tauri.app/start/prerequisites/>
  - **Linux (Debian/Ubuntu):**
    ```bash
    sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev build-essential file
    ```
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Microsoft C++ Build Tools e WebView2 (già presente su Windows 10/11 aggiornati).

## Installazione

```bash
git clone https://github.com/AleCice/Localis.git
```

```bash
cd Localis
```

```bash
npm ci
```

## Avvio

App desktop in sviluppo (avvia Vite e la finestra nativa, con ricarica automatica):

```bash
npm run tauri dev
```

Build dell'app desktop (installer nella cartella `target/release/bundle/`):

```bash
npm run tauri build
```

Build di debug senza installer, più rapida (binario in `target/debug/localis`):

```bash
npm run tauri build -- --debug --no-bundle
```

Solo interfaccia nel browser, con un backend finto in memoria (utile per lavorare sulla UI; i dati spariscono chiudendo la scheda):

```bash
npm run dev:mock
```

## Dove sono i dati

Il database SQLite `localis.db` sta nella directory dati dell'app, mai nel repository:

| Sistema | Percorso |
|---|---|
| Linux | `~/.local/share/app.localis.desktop/localis.db` (o `$XDG_DATA_HOME/app.localis.desktop/`) |
| macOS | `~/Library/Application Support/app.localis.desktop/localis.db` |
| Windows | `%APPDATA%\app.localis.desktop\localis.db` |

Le preferenze dell'interfaccia (tema, stato della sidebar, onboarding completato) sono salvate nello storage locale della webview.

Per ripartire da zero, chiudi Localis e cancella la cartella `app.localis.desktop` indicata sopra. Eliminare un progetto dall'app rimuove soltanto il suo record nel database: Localis non cancella file sul disco.

## Verifiche

Frontend:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

Rust:

```bash
cargo fmt --all --check
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
cargo test --workspace
```

Test end-to-end sull'app desktop vera: vedi le istruzioni in testa a [`e2e/native.mjs`](e2e/native.mjs) (Linux, richiede `tauri-driver` e `WebKitWebDriver`).

## Struttura

```
crates/localis-core/   dominio e SQLite (migrazioni, validazione, test); non dipende da Tauri
src-tauri/             app Tauri: comandi, permessi, configurazione
src/                   interfaccia React + TypeScript
  api/                 contratto e client verso il backend
e2e/                   test end-to-end sull'app nativa
docs/                  roadmap e stato
```

Convenzioni per chi contribuisce (anche agenti AI): [`CLAUDE.md`](CLAUDE.md).
