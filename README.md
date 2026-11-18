# Localis

App desktop local-first per studio e ricerca. Ogni **progetto** è un contenitore libero (un corso, una tesi, una ricerca) in cui, nelle prossime versioni, raccoglierai documenti e lezioni, farai domande con citazioni verificabili e produrrai materiali di studio collegati alle fonti.

**Versione 0.2 — Libreria documenti.** Oggi Localis permette di:
- creare, ritrovare ed eliminare progetti (onboarding, tema chiaro/scuro);
- importare in un progetto PDF, TXT, Markdown, DOCX e immagini (PNG, JPEG, GIF, WebP), fino a 200 MB per file, con il pulsante «Importa» o trascinandoli nella finestra;
- organizzarli in cartelle e caricarne nuove versioni;
- aprirli: PDF e immagini nel viewer, gli altri formati come testo estratto;
- cercare nel testo estratto, con l'indicazione della pagina o del blocco.

La Chat compare nella navigazione ma non è ancora disponibile. Visione e versioni: [`docs/ROADMAP.md`](docs/ROADMAP.md). Stato verificato: [`docs/STATUS.md`](docs/STATUS.md).

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

Le preferenze dell'interfaccia (tema, stato della sidebar, onboarding completato) sono nello storage locale della webview: su Linux in `app.localis.desktop/localstorage/`, su macOS e Windows nella cartella dati della webview di sistema (non verificato su queste piattaforme).

### Documenti importati

Localis **copia** ogni file importato nel proprio archivio, la sottocartella `originals/` della cartella dati, e non tiene riferimenti ai file sul tuo disco. Così le copie restano valide anche se sposti o cancelli i file di partenza, al costo dello spazio occupato.

- Ogni copia è salvata con il nome del suo hash SHA-256 (`originals/ab/abcd…`). È identica byte per byte al file importato e viene ricontrollata ogni volta che la apri: se manca o è stata alterata, Localis lo dice invece di mostrarla.
- Lo stesso file importato due volte nello stesso progetto viene riconosciuto come «già presente». In progetti diversi è consentito e la copia viene condivisa.
- Il testo estratto e l'indice di ricerca stanno nel database, separati dagli originali. Non vengono generate anteprime.
- Un PDF senza testo (per esempio una scansione) si apre ma non è ricercabile: l'OCR non c'è ancora. Le immagini si aprono ma non sono ricercabili.

### Cancellazioni e reset

Eliminare un documento o un progetto rimuove i record e le copie di Localis che nessun altro documento usa più. **I file sul tuo disco non vengono mai toccati.**

Per ripartire da zero, chiudi Localis e cancella la cartella `app.localis.desktop` indicata sopra. Così rimuovi database e archivio e, su Linux, anche le preferenze.

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

Test end-to-end sull'app desktop vera (Linux), con una directory dati temporanea isolata. `e2e/native.mjs` copre i progetti: crea, valida, riavvia, elimina. `e2e/library.mjs` copre la libreria con file sintetici: import, estrazione, ricerca, viewer, cartelle, versioni, duplicati, integrità, cancellazioni, riavvio. Richiede `WebKitWebDriver` (pacchetto `webkit2gtk-driver`), `tauri-driver` (`cargo install tauri-driver --locked`) e, senza display, `xvfb-run`. Dettagli in testa a [`e2e/native.mjs`](e2e/native.mjs).

```bash
npm run tauri build -- --debug --no-bundle
```

```bash
node e2e/native.mjs
```

```bash
node e2e/library.mjs
```

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
